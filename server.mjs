import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readFileSync, createReadStream } from "fs";
import { basename } from "path";

// ── Config ──────────────────────────────────────────────────────────────────
const TRANSPORT = process.env.TRANSPORT || "http";
const PORT = process.env.PORT || 3000;
const BASE_URL = "https://api.blogvault.net/api/v6";

// ── Multi-account ───────────────────────────────────────────────────────────
let accounts = {};

try {
  const raw = readFileSync("accounts.json", "utf-8");
  accounts = JSON.parse(raw);
  console.error(`[Config] Loaded ${Object.keys(accounts).length} account(s) from accounts.json`);
} catch {
  const jsonEnv = process.env.ACCOUNTS_JSON;
  if (jsonEnv) {
    try {
      accounts = JSON.parse(jsonEnv);
      console.error(`[Config] Loaded ${Object.keys(accounts).length} account(s) from ACCOUNTS_JSON env`);
    } catch (e) {
      console.error("FATAL: ACCOUNTS_JSON is not valid JSON:", e.message);
      process.exit(1);
    }
  } else {
    const token = process.env.WPREMOTE_API_TOKEN;
    if (token) {
      accounts["default"] = { api_token: token };
      console.error("[Config] Single account from WPREMOTE_API_TOKEN env");
    } else {
      console.error("FATAL: No accounts. Provide accounts.json, ACCOUNTS_JSON, or WPREMOTE_API_TOKEN.");
      process.exit(1);
    }
  }
}

// ── API Helper ──────────────────────────────────────────────────────────────
async function api(accountName, method, path, { query, body, timeoutMs = 60000, isMultipart = false, formData = null } = {}) {
  const acct = accounts[accountName];
  if (!acct) throw new Error(`Account "${accountName}" not found. Available: ${Object.keys(accounts).join(", ")}`);

  let url = `${BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        params.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  console.error(`[API] ${method} ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${acct.api_token}`,
      Accept: "application/json",
    },
    signal: controller.signal,
  };

  if (isMultipart && formData) {
    opts.body = formData;
    // Let fetch set Content-Type with boundary for FormData
  } else if (body && ["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, opts);
    clearTimeout(timeout);
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.substring(0, 500)}`);
      return { raw: text, status: res.status };
    }

    if (!res.ok) {
      const raw = data.message || data.error || data;
      const msg = typeof raw === "string" ? raw : JSON.stringify(raw).substring(0, 500);
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }

    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error(`Request timeout after ${timeoutMs / 1000}s`);
    throw err;
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

// Format a single key-value pair with clean output
function fmtValue(val) {
  if (val === null || val === undefined) return "–";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (Array.isArray(val)) {
    if (val.length === 0) return "(empty)";
    if (val.every(v => typeof v === "string" || typeof v === "number")) return val.join(", ");
    return val.map(v => typeof v === "object" ? JSON.stringify(v) : String(v)).join(", ");
  }
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

// Make a key label human-readable: snake_case → Title Case
function labelKey(key) {
  return key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// Format a flat object as aligned key-value block
function fmtObject(obj, indent = "") {
  if (!obj || typeof obj !== "object") return String(obj ?? "–");
  const entries = Object.entries(obj).filter(([k, v]) => v !== null && v !== undefined && v !== "");
  if (entries.length === 0) return "(empty)";
  const maxKeyLen = Math.min(30, Math.max(...entries.map(([k]) => k.length)));
  return entries.map(([k, v]) => {
    const label = (k + ":").padEnd(maxKeyLen + 2);
    const val = typeof v === "object" && !Array.isArray(v) ? "\n" + fmtObject(v, indent + "  ") : fmtValue(v);
    return `${indent}${label} ${val}`;
  }).join("\n");
}

// ── Entity-specific formatters ──
const entityFormatters = {
  // Site (list item format — summary line)
  site(s) {
    const url = s.url || s.home_url || s.title || "Site #" + s.id;
    const conn = s.connection?.status || "";
    const wp = s.wp?.core?.current_version || "";
    const client = s.client?.name || "";
    const parts = [url];
    if (s.id) parts.push(`[${s.id}]`);
    if (conn) parts.push(conn);
    if (wp) parts.push(`WP ${wp}`);
    if (client) parts.push(`Client: ${client}`);
    return parts.join("  ");
  },

  // Plugin
  plugin(p) {
    const status = (p.active || p.is_active) ? "Active" : "Inactive";
    const update = p.update_available ? ` → ${p.latest_version || p.update_available}` : "";
    const locked = p.locked ? " [Locked]" : "";
    return `${p.name || p.slug || "?"} v${p.current_version || p.version || "?"}  [${status}]${update}${locked}`;
  },

  // Theme
  theme(t) {
    const active = (t.active || t.is_active) ? " (Active)" : "";
    const update = t.update_available ? ` → ${t.latest_version || t.update_available}` : "";
    return `${t.name || t.slug || "?"} v${t.current_version || t.version || "?"}${active}${update}`;
  },

  // User
  user(u) {
    const role = u.roles ? (Array.isArray(u.roles) ? u.roles.join(", ") : u.roles) : u.role || "";
    return `${u.user_login || u.username || u.display_name || "?"} <${u.user_email || u.email || "–"}> [${role}]`;
  },

  // Task
  task(t) {
    const pct = t.progress !== undefined ? ` (${t.progress}%)` : "";
    return `Task #${t.id}  ${t.type || "–"}  Status: ${t.status || "–"}${pct}${t.message ? "  " + t.message : ""}`;
  },

  // Backup
  backup(b) {
    return `Backup #${b.id || "?"}  ${b.created_at || b.date || "–"}  Status: ${b.status || "–"}  Size: ${b.size || "–"}`;
  },

  // Client
  client(c) {
    const name = c.name || c.company_name || "Client #" + c.id;
    const sites = c.site_ids ? `  Sites: ${c.site_ids.length}` : (c.sites_count !== undefined ? `  Sites: ${c.sites_count}` : "");
    return `${name}  ${c.email || ""}${sites}`;
  },

  // Firewall log entry
  firewall_log(l) {
    return `${l.created_at || "–"}  ${l.ip || "–"}  ${l.method || "–"} ${l.url || l.path || "–"}  → ${l.status || l.action || "–"}  ${l.reason || ""}`;
  },

  // Note
  note(n) {
    const preview = n.content ? n.content.substring(0, 120).replace(/\n/g, " ") : "";
    return `Note #${n.id || "?"}  ${n.created_at || "–"}  ${preview}`;
  },

  // Generic: auto-detect by picking most useful fields
  generic(item) {
    if (typeof item !== "object" || item === null) return String(item);
    const id = item.id || item.ID || "";
    const name = item.name || item.title || item.label || item.slug || item.url || "";
    const status = item.status || "";
    const header = [id ? `#${id}` : "", name, status ? `[${status}]` : ""].filter(Boolean).join("  ");
    if (header.trim()) return header;
    // Fallback: show first 5 meaningful fields
    const useful = Object.entries(item)
      .filter(([k, v]) => v !== null && v !== undefined && v !== "" && typeof v !== "object")
      .slice(0, 5);
    return useful.map(([k, v]) => `${k}: ${v}`).join("  |  ");
  }
};

// Detect which entity formatter to use based on data shape
function detectEntity(item) {
  if (!item || typeof item !== "object") return "generic";
  // Site: has url + connection/sync/services/wp
  if ((item.url || item.home_url) && (item.connection || item.sync || item.services || item.wp)) return "site";
  // Plugin: has slug + active/current_version, not a user
  if ((item.active !== undefined || item.is_active !== undefined) && (item.slug || item.filename) && !item.user_login) {
    if (item.stylesheet || item.template) return "theme";
    return "plugin";
  }
  // User
  if (item.user_login || item.user_email || (item.roles && (item.username || item.display_name))) return "user";
  // Task
  if (item.type && (item.progress !== undefined || item.status) && item.id) return "task";
  // Backup
  if (item.backup_type || item.snapshot_id || (item.status && item.created_at && (item.size || item.files))) return "backup";
  // Client: has email + company_name/site_ids
  if (item.company_name || item.site_ids) return "client";
  // Firewall log
  if (item.ip && (item.method || item.action)) return "firewall_log";
  // Note
  if (item.content && item.created_at && !item.url) return "note";
  return "generic";
}

// Find the main data key in API response (excludes 'meta')
function findDataKey(data) {
  const keys = Object.keys(data).filter(k => k !== "meta");
  if (keys.length === 1) return keys[0];
  // Prefer known entity keys
  const known = ["sites", "site", "clients", "client", "tasks", "task", "tags", "tag",
    "plugins", "themes", "users", "backups", "notes", "reports", "team_members",
    "staging_sites", "sender_emails", "auto_update_schedules", "scheduled_reports",
    "report_templates", "custom_works", "managed_accounts", "geo_blocked_countries",
    "firewall_logs", "infected_files", "redirections", "malicious_plugins",
    "malicious_scripts", "malicious_cron_jobs", "login_attempts", "activity_logs",
    "important_pages", "files", "tables", "performances_reports", "site_notes"];
  for (const k of known) if (data[k] !== undefined) return k;
  return keys[0] || null;
}

// Format nested WP data: sites[].wp.plugins/themes/users
function fmtNestedWp(sites, wpKey) {
  const lines = [];
  for (const site of sites) {
    const wpData = site.wp?.[wpKey];
    if (!wpData || !Array.isArray(wpData)) continue;
    lines.push(`── ${site.url || site.title || site.id} ──`);
    if (wpData.length === 0) {
      lines.push("  (none)");
    } else {
      for (const item of wpData) {
        if (wpKey === "plugins") {
          const status = item.active ? "Active" : "Inactive";
          const update = item.update_available ? ` → ${item.latest_version}` : "";
          const locked = item.locked ? " [Locked]" : "";
          lines.push(`  ${item.name} v${item.current_version || item.version || "?"}  [${status}]${update}${locked}`);
        } else if (wpKey === "themes") {
          const active = item.active ? " (Active)" : "";
          const update = item.update_available ? ` → ${item.latest_version}` : "";
          lines.push(`  ${item.name} v${item.current_version || item.version || "?"}${active}${update}`);
        } else if (wpKey === "users") {
          const role = item.roles ? (Array.isArray(item.roles) ? item.roles.join(", ") : item.roles) : item.role || "";
          lines.push(`  ${item.user_login || item.username || "?"} <${item.user_email || "–"}> [${role}]`);
        } else if (wpKey === "updates") {
          lines.push(`  ${item.name || item.slug || "?"} ${item.current_version || ""} → ${item.latest_version || item.new_version || "?"} [${item.type || "–"}]`);
        } else {
          lines.push(`  ${entityFormatters.generic(item)}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Smart auto-format: detects lists, single items, nested WP data, raw data
function fmt(data, accountName = "") {
  const prefix = accountName ? `[${accountName}] ` : "";
  if (!data) return prefix + "OK (no data returned).";
  if (typeof data === "string") return prefix + data;
  if (data.raw) return prefix + data.raw;

  // Message response: { message: "..." }
  if (data.message && Object.keys(data).length <= 3) {
    return prefix + data.message;
  }

  // Task response shortcut
  if (data.task) {
    return prefix + entityFormatters.task(data.task);
  }

  const dataKey = findDataKey(data);
  if (!dataKey) return prefix + fmtObject(data);
  const payload = data[dataKey];
  const meta = data.meta?.pagination || data.meta || {};

  // ── Array response (list) ──
  if (Array.isArray(payload)) {
    const page = meta.page || meta.current_page || 1;
    const totalPages = meta.totalPages || meta.total_pages || meta.last_page || "?";
    const total = meta.totalItems || meta.total || payload.length;
    const perPage = meta.perPage || meta.per_page || payload.length;

    let header = `${total} ${dataKey}`;
    if (totalPages !== "?" && totalPages > 1) header += ` | Page ${page}/${totalPages} (${perPage}/page)`;
    header += "\n" + "─".repeat(Math.min(60, header.length + 10));

    if (payload.length === 0) return prefix + header + "\n(no items)";

    // Detect nested WP data: sites[].wp.plugins/themes/users/updates
    const firstItem = payload[0];
    if (firstItem.wp && typeof firstItem.wp === "object") {
      const wpKeys = Object.keys(firstItem.wp).filter(k =>
        Array.isArray(firstItem.wp[k]) && firstItem.wp[k].length > 0
      );
      if (wpKeys.length > 0) {
        const parts = [prefix + header];
        for (const wk of wpKeys) {
          parts.push(fmtNestedWp(payload, wk));
        }
        return parts.join("\n");
      }
    }

    // Regular list formatting
    const entityType = detectEntity(firstItem);
    const formatter = entityFormatters[entityType] || entityFormatters.generic;
    const formatted = payload.map((item, i) => `${i + 1}. ${formatter(item)}`).join("\n");
    return prefix + header + "\n" + formatted;
  }

  // ── Single object response ──
  if (typeof payload === "object" && payload !== null) {
    const entityType = detectEntity(payload);
    if (entityType !== "generic") {
      const formatter = entityFormatters[entityType];
      const summary = formatter(payload);
      // For sites, add services overview
      if (entityType === "site") {
        const lines = [summary];
        if (payload.connection) lines.push(`Connection: ${payload.connection.status || "–"} (last check: ${payload.connection.last_checked_at || "–"})`);
        if (payload.sync) lines.push(`Sync: ${payload.sync.last_sync_status || "–"} (last: ${payload.sync.last_sync_at || "–"}, next: ${payload.sync.next_sync_at || "–"})`);
        if (payload.server) lines.push(`Server: PHP ${payload.server.php_version || "–"}, MySQL ${payload.server.mysql_version || "–"}`);
        if (payload.services) {
          const active = Object.entries(payload.services).filter(([,v]) => v).map(([k]) => k);
          const inactive = Object.entries(payload.services).filter(([,v]) => !v).map(([k]) => k);
          if (active.length) lines.push(`Services ON: ${active.join(", ")}`);
          if (inactive.length) lines.push(`Services OFF: ${inactive.join(", ")}`);
        }
        if (payload.backups) {
          lines.push(`Backups: ${payload.backups.enabled ? "Enabled" : "Disabled"}, ${payload.backups.available_backups || 0} available, retention ${payload.backups.retention || "–"} days`);
          if (payload.backups.last_backup) lines.push(`  Last backup: ${payload.backups.last_backup.created_at} [${payload.backups.last_backup.status}]`);
        }
        if (payload.security?.malware_scanner) {
          const ms = payload.security.malware_scanner;
          lines.push(`Malware: ${ms.status} (last scan: ${ms.last_check_at || "–"}, files: ${ms.files?.scanned || 0}/${ms.files?.total || 0})`);
        }
        if (payload.wp?.core) {
          const core = payload.wp.core;
          lines.push(`WordPress: ${core.current_version}${core.update_available ? " → " + core.latest_version : " (up to date)"}`);
        }
        return prefix + lines.join("\n");
      }
      return prefix + summary + "\n\n" + fmtObject(payload);
    }
    return prefix + fmtObject(payload);
  }

  // Fallback
  return prefix + fmtObject(data);
}

function fmtTask(data, accountName) {
  if (!data) return fmt("Operation completed (no data returned).", accountName);
  const prefix = accountName ? `[${accountName}] ` : "";

  const task = data.task || data.data?.task || data;
  if (task.id) {
    const lines = [
      `Task #${task.id} created`,
      `  Type:   ${task.type || "N/A"}`,
      `  Status: ${task.status || "queued"}`,
    ];
    if (task.progress !== undefined) lines.push(`  Progress: ${task.progress}%`);
    if (task.message) lines.push(`  Message: ${task.message}`);
    lines.push("");
    lines.push(`→ Use get_tasks(task_id: "${task.id}") to check progress.`);
    return prefix + lines.join("\n");
  }

  // Not a task response, fall back to smart fmt
  return fmt(data, accountName);
}

function ok(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function err(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function parseJsonParam(val, name) {
  if (!val) return undefined;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch (e) {
    throw new Error(`Parameter "${name}" is not valid JSON: ${e.message}`);
  }
}

// ── Server Factory ──────────────────────────────────────────────────────────
function createServer() {
  const server = new McpServer({
    name: "wpremote-mcp-server",
    version: "1.0.0",
  });

  // ── list_accounts ─────────────────────────────────────────────────────
  server.tool(
    "list_accounts",
    "List all configured WP Remote accounts.",
    {},
    async () => {
      const lines = Object.entries(accounts).map(([name, acct]) => {
        const token = acct.api_token || "";
        const masked = token.substring(0, 8) + "..." + token.substring(token.length - 4);
        return `  ${name}: ${masked}`;
      });
      return ok(`Available accounts (${lines.length}):\n${lines.join("\n")}`);
    }
  );


  // ── Clients: GET /clients ──
  server.tool(
    "list_clients",
    "List clients",
    {
    account: z.string().describe("Account name from list_accounts."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, updated_at, first_n"),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, page, perPage, sort, filters }) => {
    try {
      const query = { page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/clients`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Clients: POST /clients ──
  server.tool(
    "create_clients",
    "Create client",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Clients."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/clients`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Clients: POST /clients/delete ──
  server.tool(
    "delete_clients_delete",
    "Bulk delete clients",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Clients."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/clients/delete`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Clients: GET /clients/{client_id} ──
  server.tool(
    "get_clients",
    "Show client",
    {
    account: z.string().describe("Account name from list_accounts."),
    client_id: z.string().describe("client id"),
    },
    async ({ account, client_id }) => {
    try {
      const data = await api(account, "GET", `/clients/${client_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Clients: PUT /clients/{client_id} ──
  server.tool(
    "update_clients",
    "Update client",
    {
    account: z.string().describe("Account name from list_accounts."),
    client_id: z.string().describe("client id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Clients."),
    },
    async ({ account, client_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/clients/${client_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tasks: GET /tasks ──
  server.tool(
    "list_tasks",
    "List tasks",
    {
    account: z.string().describe("Account name from list_accounts."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, updated_at, id, sta"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, sort, page, perPage, filters }) => {
    try {
      const query = { sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/tasks`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tasks: GET /tasks/{task_id} ──
  server.tool(
    "get_tasks",
    "Show task",
    {
    account: z.string().describe("Account name from list_accounts."),
    task_id: z.string().describe("task id"),
    },
    async ({ account, task_id }) => {
    try {
      const data = await api(account, "GET", `/tasks/${task_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tasks: POST /tasks/{task_id}/cancel ──
  server.tool(
    "do_tasks_cancel",
    "Cancel task",
    {
    account: z.string().describe("Account name from list_accounts."),
    task_id: z.string().describe("task id"),
    task_id: z.string().describe("Task ID."),
    },
    async ({ account, task_id }) => {
    try {
      const query = { task_id };
      const data = await api(account, "POST", `/tasks/${task_id}/cancel`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ManagedAccounts: GET /managed-accounts ──
  server.tool(
    "list_managed_accounts",
    "List managed accounts",
    {
    account: z.string().describe("Account name from list_accounts."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, page, perPage, filters }) => {
    try {
      const query = { page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/managed-accounts`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ManagedAccounts: DELETE /managed-accounts/{managed_account_id} ──
  server.tool(
    "delete_managed_accounts",
    "Leave managed account",
    {
    account: z.string().describe("Account name from list_accounts."),
    managed_account_id: z.string().describe("managed account id"),
    },
    async ({ account, managed_account_id }) => {
    try {
      const data = await api(account, "DELETE", `/managed-accounts/${managed_account_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ManagedAccounts: POST /managed-accounts/{managed_account_id}/accept ──
  server.tool(
    "do_managed_accounts_accept",
    "Accept invitation",
    {
    account: z.string().describe("Account name from list_accounts."),
    managed_account_id: z.string().describe("managed account id"),
    managed_account_id: z.string().describe("Managed account ID."),
    },
    async ({ account, managed_account_id }) => {
    try {
      const query = { managed_account_id };
      const data = await api(account, "POST", `/managed-accounts/${managed_account_id}/accept`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ManagedAccounts: POST /managed-accounts/{managed_account_id}/reject ──
  server.tool(
    "do_managed_accounts_reject",
    "Reject invitation",
    {
    account: z.string().describe("Account name from list_accounts."),
    managed_account_id: z.string().describe("managed account id"),
    managed_account_id: z.string().describe("Managed account ID."),
    },
    async ({ account, managed_account_id }) => {
    try {
      const query = { managed_account_id };
      const data = await api(account, "POST", `/managed-accounts/${managed_account_id}/reject`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── TeamMembers: GET /team-members ──
  server.tool(
    "list_team_members",
    "List team members",
    {
    account: z.string().describe("Account name from list_accounts."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, updated_at, name, e"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, sort, page, perPage, filters }) => {
    try {
      const query = { sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/team-members`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── TeamMembers: POST /team-members ──
  server.tool(
    "create_team_members",
    "Create team member (invite)",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for TeamMembers."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/team-members`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── TeamMembers: GET /team-members/{team_member_id} ──
  server.tool(
    "get_team_members",
    "Show team member",
    {
    account: z.string().describe("Account name from list_accounts."),
    team_member_id: z.string().describe("team member id"),
    },
    async ({ account, team_member_id }) => {
    try {
      const data = await api(account, "GET", `/team-members/${team_member_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── TeamMembers: PUT /team-members/{team_member_id} ──
  server.tool(
    "update_team_members",
    "Update team member",
    {
    account: z.string().describe("Account name from list_accounts."),
    team_member_id: z.string().describe("team member id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for TeamMembers."),
    },
    async ({ account, team_member_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/team-members/${team_member_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── TeamMembers: DELETE /team-members/{team_member_id} ──
  server.tool(
    "delete_team_members",
    "Destroy team member",
    {
    account: z.string().describe("Account name from list_accounts."),
    team_member_id: z.string().describe("team member id"),
    },
    async ({ account, team_member_id }) => {
    try {
      const data = await api(account, "DELETE", `/team-members/${team_member_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── TeamMembers: POST /team-members/{team_member_id}/resend-invitation ──
  server.tool(
    "do_team_members_resend_invitation",
    "Resend invitation",
    {
    account: z.string().describe("Account name from list_accounts."),
    team_member_id: z.string().describe("team member id"),
    team_member_id: z.string().describe("Team member ID. Must be a pending invitation."),
    },
    async ({ account, team_member_id }) => {
    try {
      const query = { team_member_id };
      const data = await api(account, "POST", `/team-members/${team_member_id}/resend-invitation`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: GET /sender-emails ──
  server.tool(
    "list_sender_emails",
    "List sender emails",
    {
    account: z.string().describe("Account name from list_accounts."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, updated_at."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, page, perPage, sort, filters }) => {
    try {
      const query = { page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sender-emails`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: POST /sender-emails ──
  server.tool(
    "create_sender_emails",
    "Create sender email",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SenderEmails."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/sender-emails`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: GET /sender-emails/{sender_email_id} ──
  server.tool(
    "get_sender_emails",
    "Show sender email",
    {
    account: z.string().describe("Account name from list_accounts."),
    sender_email_id: z.string().describe("sender email id"),
    },
    async ({ account, sender_email_id }) => {
    try {
      const data = await api(account, "GET", `/sender-emails/${sender_email_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: PUT /sender-emails/{sender_email_id} ──
  server.tool(
    "update_sender_emails",
    "Update sender email",
    {
    account: z.string().describe("Account name from list_accounts."),
    sender_email_id: z.string().describe("sender email id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SenderEmails."),
    },
    async ({ account, sender_email_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/sender-emails/${sender_email_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: DELETE /sender-emails/{sender_email_id} ──
  server.tool(
    "delete_sender_emails",
    "Delete sender email",
    {
    account: z.string().describe("Account name from list_accounts."),
    sender_email_id: z.string().describe("sender email id"),
    },
    async ({ account, sender_email_id }) => {
    try {
      const data = await api(account, "DELETE", `/sender-emails/${sender_email_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: POST /sender-emails/{sender_email_id}/resend-verification ──
  server.tool(
    "do_sender_emails_resend_verification",
    "Resend verification email",
    {
    account: z.string().describe("Account name from list_accounts."),
    sender_email_id: z.string().describe("sender email id"),
    },
    async ({ account, sender_email_id }) => {
    try {
      const data = await api(account, "POST", `/sender-emails/${sender_email_id}/resend-verification`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: POST /sender-emails/{sender_email_id}/rotate-dkim ──
  server.tool(
    "do_sender_emails_rotate_dkim",
    "Rotate DKIM keys",
    {
    account: z.string().describe("Account name from list_accounts."),
    sender_email_id: z.string().describe("sender email id"),
    },
    async ({ account, sender_email_id }) => {
    try {
      const data = await api(account, "POST", `/sender-emails/${sender_email_id}/rotate-dkim`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: POST /sender-emails/{sender_email_id}/verify-dkim ──
  server.tool(
    "do_sender_emails_verify_dkim",
    "Verify DKIM configuration",
    {
    account: z.string().describe("Account name from list_accounts."),
    sender_email_id: z.string().describe("sender email id"),
    },
    async ({ account, sender_email_id }) => {
    try {
      const data = await api(account, "POST", `/sender-emails/${sender_email_id}/verify-dkim`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: POST /sender-emails/{sender_email_id}/verify-return-path ──
  server.tool(
    "do_sender_emails_verify_return_path",
    "Verify return path configuration",
    {
    account: z.string().describe("Account name from list_accounts."),
    sender_email_id: z.string().describe("sender email id"),
    },
    async ({ account, sender_email_id }) => {
    try {
      const data = await api(account, "POST", `/sender-emails/${sender_email_id}/verify-return-path`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SenderEmails: POST /sender-emails/{sender_email_id}/refresh ──
  server.tool(
    "do_sender_emails_refresh",
    "Refresh sender email from provider",
    {
    account: z.string().describe("Account name from list_accounts."),
    sender_email_id: z.string().describe("sender email id"),
    },
    async ({ account, sender_email_id }) => {
    try {
      const data = await api(account, "POST", `/sender-emails/${sender_email_id}/refresh`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── AutoUpdateSchedules: GET /auto-update-schedules ──
  server.tool(
    "list_auto_update_schedules",
    "List auto update schedules",
    {
    account: z.string().describe("Account name from list_accounts."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, updated_at, started"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, sort, page, perPage, filters }) => {
    try {
      const query = { sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/auto-update-schedules`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── AutoUpdateSchedules: POST /auto-update-schedules ──
  server.tool(
    "create_auto_update_schedules",
    "Create auto update schedule",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for AutoUpdateSchedules."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/auto-update-schedules`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── AutoUpdateSchedules: GET /auto-update-schedules/{auto_update_schedule_id} ──
  server.tool(
    "get_auto_update_schedules",
    "Show auto update schedule",
    {
    account: z.string().describe("Account name from list_accounts."),
    auto_update_schedule_id: z.string().describe("auto update schedule id"),
    },
    async ({ account, auto_update_schedule_id }) => {
    try {
      const data = await api(account, "GET", `/auto-update-schedules/${auto_update_schedule_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── AutoUpdateSchedules: PUT /auto-update-schedules/{auto_update_schedule_id} ──
  server.tool(
    "update_auto_update_schedules",
    "Update auto update schedule",
    {
    account: z.string().describe("Account name from list_accounts."),
    auto_update_schedule_id: z.string().describe("auto update schedule id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for AutoUpdateSchedules."),
    },
    async ({ account, auto_update_schedule_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/auto-update-schedules/${auto_update_schedule_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── AutoUpdateSchedules: DELETE /auto-update-schedules/{auto_update_schedule_id} ──
  server.tool(
    "delete_auto_update_schedules",
    "Delete auto update schedule",
    {
    account: z.string().describe("Account name from list_accounts."),
    auto_update_schedule_id: z.string().describe("auto update schedule id"),
    },
    async ({ account, auto_update_schedule_id }) => {
    try {
      const data = await api(account, "DELETE", `/auto-update-schedules/${auto_update_schedule_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── AutoUpdateSchedules: POST /auto-update-schedules/{auto_update_schedule_id}/enable ──
  server.tool(
    "enable_auto_update_schedules_enable",
    "Enable (resume) auto update schedule",
    {
    account: z.string().describe("Account name from list_accounts."),
    auto_update_schedule_id: z.string().describe("auto update schedule id"),
    auto_update_schedule_id: z.string().describe("Schedule ID."),
    },
    async ({ account, auto_update_schedule_id }) => {
    try {
      const query = { auto_update_schedule_id };
      const data = await api(account, "POST", `/auto-update-schedules/${auto_update_schedule_id}/enable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── AutoUpdateSchedules: POST /auto-update-schedules/{auto_update_schedule_id}/disable ──
  server.tool(
    "disable_auto_update_schedules_disable",
    "Disable (pause) auto update schedule",
    {
    account: z.string().describe("Account name from list_accounts."),
    auto_update_schedule_id: z.string().describe("auto update schedule id"),
    auto_update_schedule_id: z.string().describe("Schedule ID."),
    },
    async ({ account, auto_update_schedule_id }) => {
    try {
      const query = { auto_update_schedule_id };
      const data = await api(account, "POST", `/auto-update-schedules/${auto_update_schedule_id}/disable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── AutoUpdateSchedulesHistory: GET /auto-update-schedules-history ──
  server.tool(
    "list_auto_update_schedules_history",
    "List auto update schedule history",
    {
    account: z.string().describe("Account name from list_accounts."),
    auto_update_schedule_ids: z.string().optional().describe("Optional list of auto update schedule IDs to restrict history. If provided, 404 when one or more not"),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, name, schedule_id."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, auto_update_schedule_ids, sort, page, perPage, filters }) => {
    try {
      const query = { auto_update_schedule_ids, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/auto-update-schedules-history`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ReportTemplates: GET /report-templates ──
  server.tool(
    "list_report_templates",
    "List report templates",
    {
    account: z.string().describe("Account name from list_accounts."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: name, generated_by, created_at,"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, sort, page, perPage, filters }) => {
    try {
      const query = { sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/report-templates`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ReportTemplates: POST /report-templates ──
  server.tool(
    "create_report_templates",
    "Create report template",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for ReportTemplates."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/report-templates`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ReportTemplates: DELETE /report-templates ──
  server.tool(
    "delete_report_templates",
    "Bulk delete report templates",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for ReportTemplates."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "DELETE", `/report-templates`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ReportTemplates: GET /report-templates/{report_template_id} ──
  server.tool(
    "get_report_templates",
    "Show report template",
    {
    account: z.string().describe("Account name from list_accounts."),
    report_template_id: z.string().describe("report template id"),
    },
    async ({ account, report_template_id }) => {
    try {
      const data = await api(account, "GET", `/report-templates/${report_template_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ReportTemplates: PUT /report-templates/{report_template_id} ──
  server.tool(
    "update_report_templates",
    "Update report template",
    {
    account: z.string().describe("Account name from list_accounts."),
    report_template_id: z.string().describe("report template id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for ReportTemplates."),
    },
    async ({ account, report_template_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/report-templates/${report_template_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ReportTemplates: DELETE /report-templates/{report_template_id} ──
  server.tool(
    "delete_report_templates_2",
    "Delete report template",
    {
    account: z.string().describe("Account name from list_accounts."),
    report_template_id: z.string().describe("report template id"),
    },
    async ({ account, report_template_id }) => {
    try {
      const data = await api(account, "DELETE", `/report-templates/${report_template_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Reports: GET /reports ──
  server.tool(
    "list_reports",
    "List reports",
    {
    account: z.string().describe("Account name from list_accounts."),
    sort: z.string().optional().describe("Sort by field,direction (e.g. created_at,desc). Default created_at,desc. Sortable fields are model c"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, sort, page, perPage, filters }) => {
    try {
      const query = { sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/reports`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Reports: POST /reports ──
  server.tool(
    "create_reports",
    "Create report",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Reports."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/reports`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Reports: POST /reports/preview ──
  server.tool(
    "do_reports_preview",
    "Preview report",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Reports."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/reports/preview`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Reports: GET /reports/{report_id} ──
  server.tool(
    "get_reports",
    "Get report",
    {
    account: z.string().describe("Account name from list_accounts."),
    report_id: z.string().describe("report id"),
    report_id: z.string().describe("Report ID."),
    },
    async ({ account, report_id }) => {
    try {
      const query = { report_id };
      const data = await api(account, "GET", `/reports/${report_id}`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Reports: DELETE /reports/{report_id} ──
  server.tool(
    "delete_reports",
    "Delete report",
    {
    account: z.string().describe("Account name from list_accounts."),
    report_id: z.string().describe("report id"),
    report_id: z.string().describe("Report ID."),
    },
    async ({ account, report_id }) => {
    try {
      const query = { report_id };
      const data = await api(account, "DELETE", `/reports/${report_id}`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Reports: GET /reports/{report_id}/download ──
  server.tool(
    "get_reports_download",
    "Download report PDF",
    {
    account: z.string().describe("Account name from list_accounts."),
    report_id: z.string().describe("report id"),
    report_id: z.string().describe("Report ID."),
    },
    async ({ account, report_id }) => {
    try {
      const query = { report_id };
      const data = await api(account, "GET", `/reports/${report_id}/download`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Reports: POST /reports/{report_id}/send-email ──
  server.tool(
    "do_reports_send_email",
    "Send report by email",
    {
    account: z.string().describe("Account name from list_accounts."),
    report_id: z.string().describe("report id"),
    report_id: z.string().describe("Report ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Reports."),
    },
    async ({ account, report_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { report_id };
      const data = await api(account, "POST", `/reports/${report_id}/send-email`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ScheduledReports: GET /scheduled-reports ──
  server.tool(
    "list_scheduled_reports",
    "List scheduled reports",
    {
    account: z.string().describe("Account name from list_accounts."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, updated_at."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, sort, page, perPage, filters }) => {
    try {
      const query = { sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/scheduled-reports`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ScheduledReports: POST /scheduled-reports ──
  server.tool(
    "create_scheduled_reports",
    "Create scheduled report",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for ScheduledReports."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/scheduled-reports`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ScheduledReports: POST /scheduled-reports/preview ──
  server.tool(
    "do_scheduled_reports_preview",
    "Preview scheduled report",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for ScheduledReports."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/scheduled-reports/preview`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ScheduledReports: GET /scheduled-reports/{scheduled_report_id} ──
  server.tool(
    "get_scheduled_reports",
    "Get scheduled report",
    {
    account: z.string().describe("Account name from list_accounts."),
    scheduled_report_id: z.string().describe("scheduled report id"),
    scheduled_report_id: z.string().describe("Scheduled report ID."),
    },
    async ({ account, scheduled_report_id }) => {
    try {
      const query = { scheduled_report_id };
      const data = await api(account, "GET", `/scheduled-reports/${scheduled_report_id}`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ScheduledReports: PUT /scheduled-reports/{scheduled_report_id} ──
  server.tool(
    "update_scheduled_reports",
    "Update scheduled report",
    {
    account: z.string().describe("Account name from list_accounts."),
    scheduled_report_id: z.string().describe("scheduled report id"),
    scheduled_report_id: z.string().describe("Scheduled report ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for ScheduledReports."),
    },
    async ({ account, scheduled_report_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { scheduled_report_id };
      const data = await api(account, "PUT", `/scheduled-reports/${scheduled_report_id}`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ScheduledReports: DELETE /scheduled-reports/{scheduled_report_id} ──
  server.tool(
    "delete_scheduled_reports",
    "Delete scheduled report",
    {
    account: z.string().describe("Account name from list_accounts."),
    scheduled_report_id: z.string().describe("scheduled report id"),
    scheduled_report_id: z.string().describe("Scheduled report ID."),
    },
    async ({ account, scheduled_report_id }) => {
    try {
      const query = { scheduled_report_id };
      const data = await api(account, "DELETE", `/scheduled-reports/${scheduled_report_id}`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ScheduledReports: POST /scheduled-reports/{scheduled_report_id}/pause ──
  server.tool(
    "do_scheduled_reports_pause",
    "Pause scheduled report",
    {
    account: z.string().describe("Account name from list_accounts."),
    scheduled_report_id: z.string().describe("scheduled report id"),
    scheduled_report_id: z.string().describe("Scheduled report ID."),
    },
    async ({ account, scheduled_report_id }) => {
    try {
      const query = { scheduled_report_id };
      const data = await api(account, "POST", `/scheduled-reports/${scheduled_report_id}/pause`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── ScheduledReports: POST /scheduled-reports/{scheduled_report_id}/unpause ──
  server.tool(
    "do_scheduled_reports_unpause",
    "Unpause (resume) scheduled report",
    {
    account: z.string().describe("Account name from list_accounts."),
    scheduled_report_id: z.string().describe("scheduled report id"),
    scheduled_report_id: z.string().describe("Scheduled report ID."),
    },
    async ({ account, scheduled_report_id }) => {
    try {
      const query = { scheduled_report_id };
      const data = await api(account, "POST", `/scheduled-reports/${scheduled_report_id}/unpause`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tags: GET /tags ──
  server.tool(
    "list_tags",
    "List tags",
    {
    account: z.string().describe("Account name from list_accounts."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, updated_at, name, c"),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, page, perPage, sort, filters }) => {
    try {
      const query = { page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/tags`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tags: POST /tags ──
  server.tool(
    "create_tags",
    "Create tag",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Tags."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/tags`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tags: POST /tags/assign ──
  server.tool(
    "do_tags_assign",
    "Assign tags to sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Tags."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/tags/assign`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tags: POST /tags/remove ──
  server.tool(
    "do_tags_remove",
    "Remove tags from sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Tags."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/tags/remove`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tags: GET /tags/{tag_id} ──
  server.tool(
    "get_tags",
    "Show tag",
    {
    account: z.string().describe("Account name from list_accounts."),
    tag_id: z.string().describe("tag id"),
    },
    async ({ account, tag_id }) => {
    try {
      const data = await api(account, "GET", `/tags/${tag_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tags: PUT /tags/{tag_id} ──
  server.tool(
    "update_tags",
    "Update tag",
    {
    account: z.string().describe("Account name from list_accounts."),
    tag_id: z.string().describe("tag id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Tags."),
    },
    async ({ account, tag_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/tags/${tag_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Tags: DELETE /tags/{tag_id} ──
  server.tool(
    "delete_tags",
    "Delete tag",
    {
    account: z.string().describe("Account name from list_accounts."),
    tag_id: z.string().describe("tag id"),
    },
    async ({ account, tag_id }) => {
    try {
      const data = await api(account, "DELETE", `/tags/${tag_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── GeoBlockedCountries: GET /geo-blocked-countries ──
  server.tool(
    "list_geo_blocked_countries",
    "List sites with blocked countries",
    {
    account: z.string().describe("Account name from list_accounts."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, page, perPage, filters }) => {
    try {
      const query = { page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/geo-blocked-countries`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── GeoBlockedCountries: POST /geo-blocked-countries ──
  server.tool(
    "do_geo_blocked_countries",
    "Block countries for one or more sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for GeoBlockedCountries."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "POST", `/geo-blocked-countries`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── GeoBlockedCountries: DELETE /geo-blocked-countries ──
  server.tool(
    "delete_geo_blocked_countries",
    "Unblock countries for one or more sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for GeoBlockedCountries."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "DELETE", `/geo-blocked-countries`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── GeoBlockedCountries: GET /geo-blocked-countries/{site_id} ──
  server.tool(
    "get_geo_blocked_countries",
    "Show blocked countries for one site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    },
    async ({ account, site_id }) => {
    try {
      const data = await api(account, "GET", `/geo-blocked-countries/${site_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── StagingSites: GET /staging-sites ──
  server.tool(
    "list_staging_sites",
    "List staging sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: created_at, site_name, site_id."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, sort, page, perPage, filters }) => {
    try {
      const query = { sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/staging-sites`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── StagingSites: POST /staging-sites ──
  server.tool(
    "create_staging_sites",
    "Create staging site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().optional().describe("Site ID (target site). Required if not provided in the request body."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for StagingSites."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/staging-sites`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── StagingSites: GET /staging-sites/{staging_site_id} ──
  server.tool(
    "get_staging_sites",
    "Get staging site details",
    {
    account: z.string().describe("Account name from list_accounts."),
    staging_site_id: z.string().describe("staging site id"),
    staging_site_id: z.string().describe("Staging site ID."),
    },
    async ({ account, staging_site_id }) => {
    try {
      const query = { staging_site_id };
      const data = await api(account, "GET", `/staging-sites/${staging_site_id}`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── StagingSites: PUT /staging-sites/{staging_site_id} ──
  server.tool(
    "update_staging_sites",
    "Update staging site",
    {
    account: z.string().describe("Account name from list_accounts."),
    staging_site_id: z.string().describe("staging site id"),
    staging_site_id: z.string().describe("Staging site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for StagingSites."),
    },
    async ({ account, staging_site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { staging_site_id };
      const data = await api(account, "PUT", `/staging-sites/${staging_site_id}`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── StagingSites: DELETE /staging-sites/{staging_site_id} ──
  server.tool(
    "delete_staging_sites",
    "Delete staging site",
    {
    account: z.string().describe("Account name from list_accounts."),
    staging_site_id: z.string().describe("staging site id"),
    staging_site_id: z.string().describe("Staging site ID."),
    },
    async ({ account, staging_site_id }) => {
    try {
      const query = { staging_site_id };
      const data = await api(account, "DELETE", `/staging-sites/${staging_site_id}`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── StagingSites: POST /staging-sites/{staging_site_id}/download ──
  server.tool(
    "initiate_staging_sites_download",
    "Initiate staging site download",
    {
    account: z.string().describe("Account name from list_accounts."),
    staging_site_id: z.string().describe("staging site id"),
    staging_site_id: z.string().describe("Staging site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for StagingSites."),
    },
    async ({ account, staging_site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { staging_site_id };
      const data = await api(account, "POST", `/staging-sites/${staging_site_id}/download`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── StagingSites: GET /staging-sites/{staging_site_id}/wp-admin-login ──
  server.tool(
    "get_staging_sites_wp_admin_login",
    "Get WP admin login URL",
    {
    account: z.string().describe("Account name from list_accounts."),
    staging_site_id: z.string().describe("staging site id"),
    staging_site_id: z.string().describe("Staging site ID."),
    user_id: z.number().optional().describe("WordPress user ID to log in as. If omitted, the default admin user is used."),
    },
    async ({ account, staging_site_id, user_id }) => {
    try {
      const query = { staging_site_id, user_id };
      const data = await api(account, "GET", `/staging-sites/${staging_site_id}/wp-admin-login`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Sites: GET /sites ──
  server.tool(
    "list_sites",
    "List sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: id, url, created_at, updated_at"),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, page, perPage, sort, filters }) => {
    try {
      const query = { page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Sites: POST /sites ──
  server.tool(
    "create_site",
    "Create site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site: z.string().describe("JSON object with site details. Example: {\"url\":\"https://example.com\"}"),
    },
    async ({ account, site }) => {
    try {
      const reqBody = { site: parseJsonParam(site, "site") };
      const data = await api(account, "POST", `/sites`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Sites: GET /sites/{site_id} ──
  server.tool(
    "get_site",
    "Show site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    },
    async ({ account, site_id }) => {
    try {
      const data = await api(account, "GET", `/sites/${site_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Sites: PUT /sites/{site_id} ──
  server.tool(
    "update_site",
    "Update site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site: z.string().describe("JSON object with site details. Example: {\"url\":\"https://example.com\"}"),
    },
    async ({ account, site_id, site }) => {
    try {
      const reqBody = { site: parseJsonParam(site, "site") };
      const data = await api(account, "PUT", `/sites/${site_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Sites: DELETE /sites/{site_id} ──
  server.tool(
    "delete_site",
    "Delete site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    },
    async ({ account, site_id }) => {
    try {
      const data = await api(account, "DELETE", `/sites/${site_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── Sites: POST /sites/{site_id}/sync ──
  server.tool(
    "sync_site",
    "Trigger site sync",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for Sites."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/sync`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesActivityLogs: GET /sites/{site_id}/activity-logs ──
  server.tool(
    "list_site_activity_logs",
    "List activity logs",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. timestamp,desc). Sortable fields: timestamp, object_type, event_ty"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 500, default 25)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, sort, page, perPage, filters }) => {
    try {
      const query = { site_id, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/activity-logs`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesActivityLogs: GET /sites/{site_id}/activity-logs/status ──
  server.tool(
    "get_site_activity_logs_status",
    "Get activity log status",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/activity-logs/status`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesActivityLogs: POST /sites/{site_id}/activity-logs/enable ──
  server.tool(
    "enable_site_activity_logs_enable",
    "Enable activity logs",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/activity-logs/enable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesActivityLogs: POST /sites/{site_id}/activity-logs/disable ──
  server.tool(
    "disable_site_activity_logs_disable",
    "Disable activity logs",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/activity-logs/disable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesActivityLogs: POST /sites/{site_id}/activity-logs/export ──
  server.tool(
    "do_site_activity_logs_export",
    "Export activity logs as CSV",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesActivityLogs."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/activity-logs/export`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesImportantPages: GET /sites/{site_id}/important-pages ──
  server.tool(
    "list_site_important_pages",
    "List important pages for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/important-pages`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesImportantPages: POST /sites/{site_id}/important-pages ──
  server.tool(
    "do_site_important_pages",
    "Add an important page",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesImportantPages."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/important-pages`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesImportantPages: PUT /sites/{site_id}/important-pages ──
  server.tool(
    "update_site_important_pages",
    "Update an important page",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesImportantPages."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "PUT", `/sites/${site_id}/important-pages`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesImportantPages: DELETE /sites/{site_id}/important-pages ──
  server.tool(
    "delete_site_important_pages",
    "Remove an important page",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesImportantPages."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "DELETE", `/sites/${site_id}/important-pages`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFiles: GET /sites/{site_id}/files ──
  server.tool(
    "list_site_files",
    "List files",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot version ID. When omitted, the latest succeeded backup-enabled snapshot is used."),
    path: z.string().optional().describe("Directory path to list, relative to the snapshot root (e.g. ./wp-content/). Defaults to ./ (root)."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, snapshot_id, path, page, perPage, filters }) => {
    try {
      const query = { site_id, snapshot_id, path, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/files`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFiles: GET /sites/{site_id}/files/versions ──
  server.tool(
    "get_site_files_versions",
    "Get file versions",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot version ID. When omitted, the latest succeeded backup-enabled snapshot is used."),
    path: z.string().optional().describe("File path relative to snapshot root (e.g. ./wp-config.php)."),
    id: z.string().optional().describe("Unique file identifier."),
    },
    async ({ account, site_id, snapshot_id, path, id }) => {
    try {
      const query = { site_id, snapshot_id, path, id };
      const data = await api(account, "GET", `/sites/${site_id}/files/versions`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFiles: GET /sites/{site_id}/files/stats ──
  server.tool(
    "get_site_files_stats",
    "Get file stats",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot version ID. When omitted, the latest succeeded backup-enabled snapshot is used."),
    path: z.string().optional().describe("Directory path to scope stats to (e.g. ./wp-content/). When omitted, stats cover the entire snapshot"),
    },
    async ({ account, site_id, snapshot_id, path }) => {
    try {
      const query = { site_id, snapshot_id, path };
      const data = await api(account, "GET", `/sites/${site_id}/files/stats`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFiles: GET /sites/{site_id}/files/download ──
  server.tool(
    "get_site_files_download",
    "Download file",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    path: z.string().optional().describe("File path relative to snapshot root (e.g. ./wp-config.php)."),
    id: z.string().optional().describe("Unique file identifier."),
    time: z.string().optional().describe("File modification time (ISO 8601) used to locate a specific version."),
    size: z.number().optional().describe("File size in bytes used to locate a specific version."),
    display: z.string().optional().describe("When present (any value), the file is served inline as text/plain instead of as a download attachmen"),
    },
    async ({ account, site_id, path, id, time, size, display }) => {
    try {
      const query = { site_id, path, id, time, size, display };
      const data = await api(account, "GET", `/sites/${site_id}/files/download`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFiles: PUT /sites/{site_id}/files/sync ──
  server.tool(
    "update_site_files_sync",
    "Mark paths for next sync",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesFiles."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "PUT", `/sites/${site_id}/files/sync`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFiles: PUT /sites/{site_id}/files/skip ──
  server.tool(
    "update_site_files_skip",
    "Mark paths to skip on next sync",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesFiles."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "PUT", `/sites/${site_id}/files/skip`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesTables: GET /sites/{site_id}/tables ──
  server.tool(
    "list_site_tables",
    "List tables",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot version ID. When omitted, the latest succeeded backup-enabled snapshot is used."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. name,desc). Sortable fields: name, rows, size. Default: name,desc."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, snapshot_id, page, perPage, sort, filters }) => {
    try {
      const query = { site_id, snapshot_id, page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/tables`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesTables: GET /sites/{site_id}/tables/stats ──
  server.tool(
    "get_site_tables_stats",
    "Get table stats",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot version ID. When omitted, the latest succeeded backup-enabled snapshot is used."),
    },
    async ({ account, site_id, snapshot_id }) => {
    try {
      const query = { site_id, snapshot_id };
      const data = await api(account, "GET", `/sites/${site_id}/tables/stats`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesTables: POST /sites/{site_id}/tables/sync ──
  server.tool(
    "do_site_tables_sync",
    "Mark tables for sync",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot version ID used to validate table names. When omitted, the latest succeeded backup-enabled "),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesTables."),
    },
    async ({ account, site_id, snapshot_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id, snapshot_id };
      const data = await api(account, "POST", `/sites/${site_id}/tables/sync`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesTables: POST /sites/{site_id}/tables/skip ──
  server.tool(
    "do_site_tables_skip",
    "Mark tables to skip",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot version ID used to validate table names. When omitted, the latest succeeded backup-enabled "),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesTables."),
    },
    async ({ account, site_id, snapshot_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id, snapshot_id };
      const data = await api(account, "POST", `/sites/${site_id}/tables/skip`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesInfectedFiles: GET /sites/{site_id}/infected-files ──
  server.tool(
    "list_site_infected_files",
    "List infected files",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Optional snapshot ID; otherwise the latest completed malware scan snapshot for the site is used."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. infected_at,desc). Sortable fields: infected_at, b64name, marked_a"),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, snapshot_id, page, perPage, sort, filters }) => {
    try {
      const query = { site_id, snapshot_id, page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/infected-files`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesInfectedFiles: PUT /sites/{site_id}/infected-files/mark-as-safe ──
  server.tool(
    "update_site_infected_files_mark_as_safe",
    "Mark files as safe",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesInfectedFiles."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "PUT", `/sites/${site_id}/infected-files/mark-as-safe`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesInfectedFiles: PUT /sites/{site_id}/infected-files/mark-as-unsafe ──
  server.tool(
    "update_site_infected_files_mark_as_unsafe",
    "Mark files as unsafe",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesInfectedFiles."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "PUT", `/sites/${site_id}/infected-files/mark-as-unsafe`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesInfectedFiles: GET /sites/{site_id}/infected-files/{file_id}/content ──
  server.tool(
    "get_site_infected_files_content",
    "Get file content",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    file_id: z.string().describe("file id"),
    site_id: z.string().describe("Site ID."),
    file_id: z.string().describe("Infected file ID."),
    },
    async ({ account, site_id, file_id }) => {
    try {
      const query = { site_id, file_id };
      const data = await api(account, "GET", `/sites/${site_id}/infected-files/${file_id}/content`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesRedirections: GET /sites/{site_id}/redirections ──
  server.tool(
    "list_site_redirections",
    "List redirections for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. type,asc). Sortable fields: type, location, from, to, discovered_a"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, sort, page, perPage, filters }) => {
    try {
      const query = { site_id, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/redirections`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesRedirections: PUT /sites/{site_id}/redirections/mark-as-safe ──
  server.tool(
    "update_site_redirections_mark_as_safe",
    "Mark redirect URLs as safe",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesRedirections."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "PUT", `/sites/${site_id}/redirections/mark-as-safe`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMaliciousPlugins: GET /sites/{site_id}/malicious-plugins ──
  server.tool(
    "list_site_malicious_plugins",
    "List malicious plugins for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. first_seen_at,desc). Sortable fields: title, slug, first_seen_at, "),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, sort, page, perPage, filters }) => {
    try {
      const query = { site_id, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/malicious-plugins`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMaliciousScripts: GET /sites/{site_id}/malicious-scripts ──
  server.tool(
    "list_site_malicious_scripts",
    "List malicious scripts for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot ID. If omitted, the latest completed malware scan snapshot is used."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. discovered_at,desc). Sortable fields: discovered_at, score, md5."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, snapshot_id, sort, page, perPage, filters }) => {
    try {
      const query = { site_id, snapshot_id, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/malicious-scripts`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMaliciousScripts: GET /sites/{site_id}/malicious-scripts/{malicious_script_id} ──
  server.tool(
    "get_site_malicious_scripts",
    "Get a malicious script by id (md5)",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    malicious_script_id: z.string().describe("malicious script id"),
    site_id: z.string().describe("Site ID."),
    malicious_script_id: z.string().describe("Script identifier (md5 hash)."),
    snapshot_id: z.string().optional().describe("Snapshot ID. If omitted, the latest completed malware scan snapshot is used."),
    },
    async ({ account, site_id, malicious_script_id, snapshot_id }) => {
    try {
      const query = { site_id, malicious_script_id, snapshot_id };
      const data = await api(account, "GET", `/sites/${site_id}/malicious-scripts/${malicious_script_id}`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMaliciousScripts: GET /sites/{site_id}/malicious-scripts/{malicious_script_id}/content ──
  server.tool(
    "get_site_malicious_scripts_content",
    "Get script source content (base64)",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    malicious_script_id: z.string().describe("malicious script id"),
    site_id: z.string().describe("Site ID."),
    malicious_script_id: z.string().describe("Script identifier (md5 hash)."),
    snapshot_id: z.string().optional().describe("Snapshot ID. If omitted, the latest completed malware scan snapshot is used."),
    },
    async ({ account, site_id, malicious_script_id, snapshot_id }) => {
    try {
      const query = { site_id, malicious_script_id, snapshot_id };
      const data = await api(account, "GET", `/sites/${site_id}/malicious-scripts/${malicious_script_id}/content`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMaliciousScripts: PUT /sites/{site_id}/malicious-scripts/mark-as-safe ──
  server.tool(
    "update_site_malicious_scripts_mark_as_safe",
    "Mark malicious scripts as safe",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot ID. If omitted, the latest completed malware scan snapshot is used."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesMaliciousScripts."),
    },
    async ({ account, site_id, snapshot_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id, snapshot_id };
      const data = await api(account, "PUT", `/sites/${site_id}/malicious-scripts/mark-as-safe`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMaliciousCronJobs: GET /sites/{site_id}/malicious-cron-jobs ──
  server.tool(
    "list_site_malicious_cron_jobs",
    "List malicious cron jobs for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot ID. If omitted, latest succeeded malware scan snapshot is used."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    },
    async ({ account, site_id, snapshot_id, page, perPage }) => {
    try {
      const query = { site_id, snapshot_id, page, perPage };
      const data = await api(account, "GET", `/sites/${site_id}/malicious-cron-jobs`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMaliciousCronJobs: PUT /sites/{site_id}/malicious-cron-jobs/mark-as-safe ──
  server.tool(
    "update_site_malicious_cron_jobs_mark_as_safe",
    "Mark selected malicious cron jobs as safe",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    snapshot_id: z.string().optional().describe("Snapshot ID. If omitted, latest succeeded malware scan snapshot is used."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesMaliciousCronJobs."),
    },
    async ({ account, site_id, snapshot_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id, snapshot_id };
      const data = await api(account, "PUT", `/sites/${site_id}/malicious-cron-jobs/mark-as-safe`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesLoginAttempts: GET /sites/{site_id}/login-attempts ──
  server.tool(
    "list_site_login_attempts",
    "List login attempts",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. time,desc). Sortable fields: time, ip_address, username. Default: "),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, sort, page, perPage, filters }) => {
    try {
      const query = { site_id, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/login-attempts`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesLoginAttempts: GET /sites/{site_id}/login-attempts/stats ──
  server.tool(
    "get_site_login_attempts_stats",
    "Get login attempt statistics",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, filters }) => {
    try {
      const query = { site_id, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/login-attempts/stats`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMalwareCleanup: POST /sites/{site_id}/malware-cleanup ──
  server.tool(
    "initiate_site_malware_cleanup",
    "Initiate malware cleanup",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesMalwareCleanup."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/malware-cleanup`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMalwareCleanup: GET /sites/{site_id}/malware-cleanup/can-auto-clean ──
  server.tool(
    "get_site_malware_cleanup_can_auto_clean",
    "Check if automatic malware cleanup is available",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/malware-cleanup/can-auto-clean`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWhitelabelPlugin: GET /sites/{site_id}/whitelabel-plugin ──
  server.tool(
    "get_site_whitelabel_plugin",
    "Get plugin branding settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    },
    async ({ account, site_id }) => {
    try {
      const data = await api(account, "GET", `/sites/${site_id}/whitelabel-plugin`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWhitelabelPlugin: PUT /sites/{site_id}/whitelabel-plugin ──
  server.tool(
    "update_site_whitelabel_plugin",
    "Update plugin branding settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesWhitelabelPlugin."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/sites/${site_id}/whitelabel-plugin`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWhitelabelWpLogin: GET /sites/{site_id}/whitelabel-wp-login ──
  server.tool(
    "get_site_whitelabel_wp_login",
    "Get WP login branding settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    },
    async ({ account, site_id }) => {
    try {
      const data = await api(account, "GET", `/sites/${site_id}/whitelabel-wp-login`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWhitelabelWpLogin: PUT /sites/{site_id}/whitelabel-wp-login ──
  server.tool(
    "update_site_whitelabel_wp_login",
    "Update WP login branding settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesWhitelabelWpLogin."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/sites/${site_id}/whitelabel-wp-login`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpWordpressCore: GET /sites/wp/wordpress_core ──
  server.tool(
    "wp_list_core",
    "List WordPress core info for sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_ids: z.string().optional().describe("Optional list of site IDs. If omitted, all accessible sites are included."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 100, default 100)."),
    },
    async ({ account, site_ids, page, perPage }) => {
    try {
      const query = { site_ids, page, perPage };
      const data = await api(account, "GET", `/sites/wp/wordpress_core`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpWordpressCore: POST /sites/wp/wordpress_core/lock ──
  server.tool(
    "wp_lock_core",
    "Lock WordPress core updates",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    },
    async ({ account, sites }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/wordpress_core/lock`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpWordpressCore: POST /sites/wp/wordpress_core/unlock ──
  server.tool(
    "wp_unlock_core",
    "Unlock WordPress core updates",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    },
    async ({ account, sites }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/wordpress_core/unlock`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpPlugins: GET /sites/wp/plugins ──
  server.tool(
    "wp_list_plugins",
    "List plugins across sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_ids: z.string().optional().describe("Optional list of site IDs. If omitted, all accessible sites are included."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 100, default 100)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. name,asc). Sortable fields: name, slug, filename, version, status,"),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_ids, page, perPage, sort, filters }) => {
    try {
      const query = { site_ids, page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/wp/plugins`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpPlugins: POST /sites/wp/plugins/install ──
  server.tool(
    "wp_install_plugins",
    "Install plugins on sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with plugins. Example: [{\"id\":\"123\",\"plugins\":[{\"slug\":\"akismet\",\"name\":\"Akismet\",\"version\":\"5.3\",\"package\":\"https://...\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/plugins/install`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpPlugins: POST /sites/wp/plugins/upload ──
  server.tool(
    "wp_upload_plugin",
    "Upload a plugin zip file",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with plugins. Example: [{\"id\":\"123\",\"plugins\":[{\"slug\":\"akismet\",\"name\":\"Akismet\",\"version\":\"5.3\",\"package\":\"https://...\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    file_url: z.string().optional().describe("HTTPS URL of the ZIP file to upload. Alternative to local file."),
    file_path: z.string().optional().describe("Local path to the ZIP file to upload."),
    },
    async ({ account, sites, override_lock, file_url, file_path }) => {
    try {
      // File upload — download from URL or read from path
      let fileBuffer;
      let fileName = "plugin.zip";
      if (file_url) {
        // Google Drive: convert sharing link to direct download URL
        let downloadUrl = file_url;
        const gdMatch = file_url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
        if (gdMatch) {
          downloadUrl = `https://drive.google.com/uc?export=download&id=${gdMatch[1]}`;
        }
        // Follow redirects (Google Drive, GitHub, etc.)
        const resp = await fetch(downloadUrl, { redirect: "follow" });
        if (!resp.ok) throw new Error(`Failed to download file: HTTP ${resp.status}`);
        fileBuffer = Buffer.from(await resp.arrayBuffer());
        // Extract filename from Content-Disposition header or URL
        const cd = resp.headers.get("content-disposition");
        if (cd) {
          const m = cd.match(/filename\*?=(?:UTF-8''|")([^";]+)/i);
          if (m) fileName = decodeURIComponent(m[1].replace(/"/g, ""));
        } else {
          fileName = downloadUrl.split("/").pop().split("?")[0] || "plugin.zip";
        }
      } else if (file_path) {
        fileBuffer = readFileSync(file_path);
        fileName = basename(file_path);
      } else {
        return err("Provide either file_url or file_path.");
      }
      // BlogVault API requires empty-bracket notation for arrays
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: "application/zip" });
      formData.append("plugins[][file]", blob, fileName);
      if (sites) {
        const sitesArr = parseJsonParam(sites, "sites");
        sitesArr.forEach((s) => {
          formData.append("sites[][id]", s.id);
        });
      }
      if (override_lock) formData.append("override_lock", "true");
      const data = await api(account, "POST", `/sites/wp/plugins/upload`, { isMultipart: true, formData });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpPlugins: POST /sites/wp/plugins/activate ──
  server.tool(
    "wp_activate_plugins",
    "Activate plugins on sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with plugins. Example: [{\"id\":\"123\",\"plugins\":[{\"slug\":\"akismet\",\"name\":\"Akismet\",\"version\":\"5.3\",\"package\":\"https://...\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/plugins/activate`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpPlugins: POST /sites/wp/plugins/deactivate ──
  server.tool(
    "wp_deactivate_plugins",
    "Deactivate plugins on sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with plugins. Example: [{\"id\":\"123\",\"plugins\":[{\"slug\":\"akismet\",\"name\":\"Akismet\",\"version\":\"5.3\",\"package\":\"https://...\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/plugins/deactivate`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpPlugins: POST /sites/wp/plugins/delete ──
  server.tool(
    "delete_wp_plugins_delete",
    "Delete plugins from sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with plugins. Example: [{\"id\":\"123\",\"plugins\":[{\"slug\":\"akismet\",\"name\":\"Akismet\",\"version\":\"5.3\",\"package\":\"https://...\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/plugins/delete`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpPlugins: POST /sites/wp/plugins/lock ──
  server.tool(
    "wp_lock_plugins",
    "Lock plugin updates on sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with plugins. Example: [{\"id\":\"123\",\"plugins\":[{\"slug\":\"akismet\",\"name\":\"Akismet\",\"version\":\"5.3\",\"package\":\"https://...\"}]}]"),
    },
    async ({ account, sites }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/plugins/lock`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpPlugins: POST /sites/wp/plugins/unlock ──
  server.tool(
    "wp_unlock_plugins",
    "Unlock plugin updates on sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with plugins. Example: [{\"id\":\"123\",\"plugins\":[{\"slug\":\"akismet\",\"name\":\"Akismet\",\"version\":\"5.3\",\"package\":\"https://...\"}]}]"),
    },
    async ({ account, sites }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/plugins/unlock`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUsers: GET /sites/wp/users ──
  server.tool(
    "wp_list_users",
    "List WP users for sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_ids: z.string().optional().describe("Site IDs to list users for. If omitted, all accessible sites are included."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. username,asc). Sortable fields: username, email, name, role, creat"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 100, default 100)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_ids, sort, page, perPage, filters }) => {
    try {
      const query = { site_ids, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/wp/users`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUsers: POST /sites/wp/users ──
  server.tool(
    "wp_create_users",
    "Create WP users",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with users. Example: [{\"id\":\"123\",\"wp_users\":[{\"username\":\"test\",\"password\":\"pass\",\"email\":\"a@b.com\",\"role\":\"administrator\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/users`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUsers: POST /sites/wp/users/delete ──
  server.tool(
    "delete_wp_users_delete",
    "Delete WP users",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with users. Example: [{\"id\":\"123\",\"wp_users\":[{\"username\":\"test\",\"password\":\"pass\",\"email\":\"a@b.com\",\"role\":\"administrator\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/users/delete`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUsers: PUT /sites/wp/users/roles ──
  server.tool(
    "wp_update_user_roles",
    "Update WP user roles",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with users. Example: [{\"id\":\"123\",\"wp_users\":[{\"username\":\"test\",\"password\":\"pass\",\"email\":\"a@b.com\",\"role\":\"administrator\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "PUT", `/sites/wp/users/roles`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUsers: PUT /sites/wp/users/passwords ──
  server.tool(
    "wp_update_user_passwords",
    "Update WP user passwords",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with users. Example: [{\"id\":\"123\",\"wp_users\":[{\"username\":\"test\",\"password\":\"pass\",\"email\":\"a@b.com\",\"role\":\"administrator\"}]}]"),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "PUT", `/sites/wp/users/passwords`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUsers: PUT /sites/wp/users/default ──
  server.tool(
    "wp_set_default_user",
    "Set default WP login user per site",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with users. Example: [{\"id\":\"123\",\"wp_users\":[{\"username\":\"test\",\"password\":\"pass\",\"email\":\"a@b.com\",\"role\":\"administrator\"}]}]"),
    },
    async ({ account, sites }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "PUT", `/sites/wp/users/default`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUsers: PUT /sites/wp/users/2fa ──
  server.tool(
    "wp_manage_2fa",
    "Manage 2FA for WP users",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects with users. Example: [{\"id\":\"123\",\"wp_users\":[{\"username\":\"test\",\"password\":\"pass\",\"email\":\"a@b.com\",\"role\":\"administrator\"}]}]"),
    },
    async ({ account, sites }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "PUT", `/sites/wp/users/2fa`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUsers: GET /sites/{site_id}/wp/users/sso-login-url ──
  server.tool(
    "get_site_wp_users_sso_login_url",
    "Get SSO login URL for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    wp_object_id: z.number().optional().describe("WordPress user ID to log in as. If omitted, the default admin user is used."),
    },
    async ({ account, site_id, wp_object_id }) => {
    try {
      const query = { site_id, wp_object_id };
      const data = await api(account, "GET", `/sites/${site_id}/wp/users/sso-login-url`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUpdates: GET /sites/wp/updates ──
  server.tool(
    "wp_list_updates",
    "List WordPress updates",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_ids: z.string().optional().describe("Optional list of site IDs. If omitted, all accessible sites are included. If provided, all must be a"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 100, default 100)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. id,asc). Sortable fields: id."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_ids, page, perPage, sort, filters }) => {
    try {
      const query = { site_ids, page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/wp/updates`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpUpdates: POST /sites/wp/updates/perform ──
  server.tool(
    "wp_perform_updates",
    "Execute WordPress updates",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/updates/perform`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpThemes: GET /sites/wp/themes ──
  server.tool(
    "wp_list_themes",
    "List themes across sites",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_ids: z.string().optional().describe("Optional list of site IDs. If omitted, all accessible sites are included."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 100, default 100)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. name,asc). Sortable fields: name, slug, filename, version, status,"),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_ids, page, perPage, sort, filters }) => {
    try {
      const query = { site_ids, page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/wp/themes`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpThemes: POST /sites/wp/themes/install ──
  server.tool(
    "wp_install_themes",
    "Install themes",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/themes/install`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpThemes: POST /sites/wp/themes/upload ──
  server.tool(
    "wp_upload_theme",
    "Upload a theme file",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    file_url: z.string().optional().describe("HTTPS URL of the ZIP file to upload. Alternative to local file."),
    file_path: z.string().optional().describe("Local path to the ZIP file to upload."),
    },
    async ({ account, sites, override_lock, file_url, file_path }) => {
    try {
      // File upload — download from URL or read from path
      let fileBuffer;
      let fileName = "plugin.zip";
      if (file_url) {
        const resp = await fetch(file_url);
        if (!resp.ok) throw new Error(`Failed to download file: HTTP ${resp.status}`);
        fileBuffer = Buffer.from(await resp.arrayBuffer());
        fileName = file_url.split("/").pop() || "plugin.zip";
      } else if (file_path) {
        fileBuffer = readFileSync(file_path);
        fileName = basename(file_path);
      } else {
        return err("Provide either file_url or file_path.");
      }
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: "application/zip" });
      formData.append("plugins[0][file]", blob, fileName);
      if (sites) {
        const sitesArr = parseJsonParam(sites, "sites");
        sitesArr.forEach((s, i) => {
          formData.append(`sites[${i}][id]`, s.id);
          if (s.options) Object.entries(s.options).forEach(([k,v]) => formData.append(`sites[${i}][options][${k}]`, String(v)));
        });
      }
      if (override_lock) formData.append("override_lock", "true");
      const data = await api(account, "POST", `/sites/wp/themes/upload`, { isMultipart: true, formData });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpThemes: POST /sites/wp/themes/activate ──
  server.tool(
    "wp_activate_themes",
    "Activate themes",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/themes/activate`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpThemes: POST /sites/wp/themes/delete ──
  server.tool(
    "delete_wp_themes_delete",
    "Delete themes",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    override_lock: z.boolean().optional().describe("Allow operation even if site/plugin is locked."),
    },
    async ({ account, sites, override_lock }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/themes/delete`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpThemes: POST /sites/wp/themes/lock ──
  server.tool(
    "wp_lock_themes",
    "Lock themes",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    },
    async ({ account, sites }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/themes/lock`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpThemes: POST /sites/wp/themes/unlock ──
  server.tool(
    "wp_unlock_themes",
    "Unlock themes",
    {
    account: z.string().describe("Account name from list_accounts."),
    sites: z.string().describe("JSON: Array of site objects. See API docs for structure."),
    },
    async ({ account, sites }) => {
    try {
      const reqBody = { sites: parseJsonParam(sites, "sites") };
      if (override_lock) reqBody.override_lock = override_lock;
      const data = await api(account, "POST", `/sites/wp/themes/unlock`, { body: reqBody });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── WhitelabelPlugin: GET /whitelabel-plugin ──
  server.tool(
    "get_whitelabel_plugin",
    "Get plugin branding",
    {
    account: z.string().describe("Account name from list_accounts."),
    },
    async ({ account }) => {
    try {
      const data = await api(account, "GET", `/whitelabel-plugin`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── WhitelabelPlugin: PUT /whitelabel-plugin ──
  server.tool(
    "update_whitelabel_plugin",
    "Update plugin branding",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for WhitelabelPlugin."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/whitelabel-plugin`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── WhitelabelPlugin: DELETE /whitelabel-plugin ──
  server.tool(
    "delete_whitelabel_plugin",
    "Reset plugin branding to default",
    {
    account: z.string().describe("Account name from list_accounts."),
    },
    async ({ account }) => {
    try {
      const data = await api(account, "DELETE", `/whitelabel-plugin`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── WhitelabelWpLogin: GET /whitelabel-wp-login ──
  server.tool(
    "get_whitelabel_wp_login",
    "Get WP Login whitelabel settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    },
    async ({ account }) => {
    try {
      const data = await api(account, "GET", `/whitelabel-wp-login`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── WhitelabelWpLogin: PUT /whitelabel-wp-login ──
  server.tool(
    "update_whitelabel_wp_login",
    "Update WP Login whitelabel settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for WhitelabelWpLogin."),
    },
    async ({ account, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/whitelabel-wp-login`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── WhitelabelWpLogin: DELETE /whitelabel-wp-login ──
  server.tool(
    "delete_whitelabel_wp_login",
    "Reset WP Login whitelabel settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    },
    async ({ account }) => {
    try {
      const data = await api(account, "DELETE", `/whitelabel-wp-login`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesPerformanceReports: GET /sites/performances/reports ──
  server.tool(
    "list_site_performances_reports",
    "List performance reports",
    {
    account: z.string().describe("Account name from list_accounts."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. id,desc). Sortable fields: id. Default: id,desc."),
    site_ids: z.string().optional().describe("Optional list of site IDs to filter results. All specified sites must be accessible to the authentic"),
    },
    async ({ account, page, perPage, sort, site_ids }) => {
    try {
      const query = { page, perPage, sort, site_ids };
      const data = await api(account, "GET", `/sites/performances/reports`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpAutoUpdates: GET /sites/{site_id}/wp-auto-updates ──
  server.tool(
    "get_site_wp_auto_updates",
    "Get WordPress auto-updates setting",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    },
    async ({ account, site_id }) => {
    try {
      const data = await api(account, "GET", `/sites/${site_id}/wp-auto-updates`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWpAutoUpdates: PUT /sites/{site_id}/wp-auto-updates ──
  server.tool(
    "update_site_wp_auto_updates",
    "Enable or disable WordPress auto-updates",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesWpAutoUpdates."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/sites/${site_id}/wp-auto-updates`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWoocommerceDbUpgrade: GET /sites/{site_id}/woocommerce-db-upgrade ──
  server.tool(
    "get_site_woocommerce_db_upgrade",
    "Get WooCommerce DB upgrade setting",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    },
    async ({ account, site_id }) => {
    try {
      const data = await api(account, "GET", `/sites/${site_id}/woocommerce-db-upgrade`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesWoocommerceDbUpgrade: PUT /sites/{site_id}/woocommerce-db-upgrade ──
  server.tool(
    "update_site_woocommerce_db_upgrade",
    "Enable or disable WooCommerce DB upgrades",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesWoocommerceDbUpgrade."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/sites/${site_id}/woocommerce-db-upgrade`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesElementorDbUpgrade: GET /sites/{site_id}/elementor-db-upgrade ──
  server.tool(
    "get_site_elementor_db_upgrade",
    "Get Elementor DB upgrade setting",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    },
    async ({ account, site_id }) => {
    try {
      const data = await api(account, "GET", `/sites/${site_id}/elementor-db-upgrade`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesElementorDbUpgrade: PUT /sites/{site_id}/elementor-db-upgrade ──
  server.tool(
    "update_site_elementor_db_upgrade",
    "Enable or disable Elementor DB upgrades",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesElementorDbUpgrade."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/sites/${site_id}/elementor-db-upgrade`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesCustomWorks: GET /sites/{site_id}/custom-works ──
  server.tool(
    "list_site_custom_works",
    "List custom works for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: title, description, performed_o"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, sort, page, perPage, filters }) => {
    try {
      const query = { site_id, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/custom-works`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesCustomWorks: POST /sites/{site_id}/custom-works ──
  server.tool(
    "create_site_custom_works",
    "Create custom works (one or many)",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesCustomWorks."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/custom-works`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesCustomWorks: GET /sites/{site_id}/custom-works/{custom_work_id} ──
  server.tool(
    "get_site_custom_works",
    "Show a custom work item",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    custom_work_id: z.string().describe("custom work id"),
    },
    async ({ account, site_id, custom_work_id }) => {
    try {
      const data = await api(account, "GET", `/sites/${site_id}/custom-works/${custom_work_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesCustomWorks: PUT /sites/{site_id}/custom-works/{custom_work_id} ──
  server.tool(
    "update_site_custom_works",
    "Update a custom work item",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    custom_work_id: z.string().describe("custom work id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesCustomWorks."),
    },
    async ({ account, site_id, custom_work_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/sites/${site_id}/custom-works/${custom_work_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesCustomWorks: DELETE /sites/{site_id}/custom-works/{custom_work_id} ──
  server.tool(
    "delete_site_custom_works",
    "Delete a custom work item",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    custom_work_id: z.string().describe("custom work id"),
    },
    async ({ account, site_id, custom_work_id }) => {
    try {
      const data = await api(account, "DELETE", `/sites/${site_id}/custom-works/${custom_work_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesNotes: GET /sites/{site_id}/notes ──
  server.tool(
    "list_site_notes",
    "List notes for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: author, content, created_at, up"),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, sort, page, perPage, filters }) => {
    try {
      const query = { site_id, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/notes`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesNotes: POST /sites/{site_id}/notes ──
  server.tool(
    "create_site_notes",
    "Create a note",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesNotes."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/notes`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesNotes: GET /sites/{site_id}/notes/{note_id} ──
  server.tool(
    "get_site_notes",
    "Show a note",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    note_id: z.string().describe("note id"),
    },
    async ({ account, site_id, note_id }) => {
    try {
      const data = await api(account, "GET", `/sites/${site_id}/notes/${note_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesNotes: PUT /sites/{site_id}/notes/{note_id} ──
  server.tool(
    "update_site_notes",
    "Update a note",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    note_id: z.string().describe("note id"),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesNotes."),
    },
    async ({ account, site_id, note_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const data = await api(account, "PUT", `/sites/${site_id}/notes/${note_id}`, { body: reqBody });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesNotes: DELETE /sites/{site_id}/notes/{note_id} ──
  server.tool(
    "delete_site_notes",
    "Delete a note",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    note_id: z.string().describe("note id"),
    },
    async ({ account, site_id, note_id }) => {
    try {
      const data = await api(account, "DELETE", `/sites/${site_id}/notes/${note_id}`);
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesNotes: GET /sites/{site_id}/notes/{note_id}/versions ──
  server.tool(
    "list_site_notes_versions",
    "List versions of a note",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    note_id: z.string().describe("note id"),
    site_id: z.string().describe("Site ID."),
    note_id: z.string().describe("Note ID."),
    },
    async ({ account, site_id, note_id }) => {
    try {
      const query = { site_id, note_id };
      const data = await api(account, "GET", `/sites/${site_id}/notes/${note_id}/versions`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesSecurity: GET /sites/{site_id}/security/status ──
  server.tool(
    "get_site_security_status",
    "Get security status",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/security/status`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesSecurity: POST /sites/{site_id}/security/enable ──
  server.tool(
    "enable_site_security_enable",
    "Enable security on a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/security/enable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesSecurity: POST /sites/{site_id}/security/disable ──
  server.tool(
    "disable_site_security_disable",
    "Disable security on a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/security/disable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackups: GET /sites/{site_id}/backups ──
  server.tool(
    "list_site_backups",
    "List backups",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. created_at,desc). Sortable fields: size, files_synced, tables_sync"),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, page, perPage, sort, filters }) => {
    try {
      const query = { site_id, page, perPage, sort, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/backups`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackups: GET /sites/{site_id}/backups/{backup_id} ──
  server.tool(
    "get_site_backups",
    "Show backup",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    backup_id: z.string().describe("backup id"),
    site_id: z.string().describe("Site ID."),
    backup_id: z.string().describe("Backup snapshot ID."),
    },
    async ({ account, site_id, backup_id }) => {
    try {
      const query = { site_id, backup_id };
      const data = await api(account, "GET", `/sites/${site_id}/backups/${backup_id}`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackups: GET /sites/{site_id}/backups/status ──
  server.tool(
    "get_site_backups_status",
    "Get backup status",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/backups/status`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackups: POST /sites/{site_id}/backups/enable ──
  server.tool(
    "enable_site_backups_enable",
    "Enable backup",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/backups/enable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackups: POST /sites/{site_id}/backups/disable ──
  server.tool(
    "disable_site_backups_disable",
    "Disable backup",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/backups/disable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewall: GET /sites/{site_id}/firewall/status ──
  server.tool(
    "get_site_firewall_status",
    "Get firewall status",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/firewall/status`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewall: POST /sites/{site_id}/firewall/enable ──
  server.tool(
    "enable_site_firewall_enable",
    "Enable firewall on a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/firewall/enable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewall: POST /sites/{site_id}/firewall/disable ──
  server.tool(
    "disable_site_firewall_disable",
    "Disable firewall on a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/firewall/disable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesPerformances: POST /sites/{site_id}/performance/enable ──
  server.tool(
    "enable_site_performance_enable",
    "Enable performance optimization",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/performance/enable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesPerformances: POST /sites/{site_id}/performance/disable ──
  server.tool(
    "disable_site_performance_disable",
    "Disable performance optimization",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/performance/disable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesPerformances: GET /sites/{site_id}/performance/status ──
  server.tool(
    "get_site_performance_status",
    "Get performance optimization status",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/performance/status`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallBotProtection: GET /sites/{site_id}/firewall/bot-protection/status ──
  server.tool(
    "get_site_firewall_bot_protection_status",
    "Get bot protection status",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/firewall/bot-protection/status`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallBotProtection: POST /sites/{site_id}/firewall/bot-protection/enable ──
  server.tool(
    "enable_site_firewall_bot_protection_enable",
    "Enable bot protection",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/firewall/bot-protection/enable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallBotProtection: POST /sites/{site_id}/firewall/bot-protection/disable ──
  server.tool(
    "disable_site_firewall_bot_protection_disable",
    "Disable bot protection",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/firewall/bot-protection/disable`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallLogs: GET /sites/{site_id}/firewall/logs ──
  server.tool(
    "list_site_firewall_logs",
    "List firewall logs",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    sort: z.string().optional().describe("Sort by field and direction (e.g. time,desc). Sortable fields: time, ip, status, resp_code, method."),
    page: z.number().optional().describe("Page number. Defaults to 1."),
    perPage: z.number().optional().describe("Number of items per page (max 20, default 20)."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, sort, page, perPage, filters }) => {
    try {
      const query = { site_id, sort, page, perPage, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/firewall/logs`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallLogs: GET /sites/{site_id}/firewall/logs/stats ──
  server.tool(
    "get_site_firewall_logs_stats",
    "Get firewall log statistics",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, filters }) => {
    try {
      const query = { site_id, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/firewall/logs/stats`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallLogs: POST /sites/{site_id}/firewall/logs/download ──
  server.tool(
    "do_site_firewall_logs_download",
    "Request firewall log download",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesFirewallLogs."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/firewall/logs/download`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallLogs: GET /sites/{site_id}/firewall/logs/geo-data ──
  server.tool(
    "get_site_firewall_logs_geo_data",
    "Get geographic breakdown of firewall traffic",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, filters }) => {
    try {
      const query = { site_id, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/firewall/logs/geo-data`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallLogs: GET /sites/{site_id}/firewall/logs/bots-data ──
  server.tool(
    "get_site_firewall_logs_bots_data",
    "Get bot traffic breakdown",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    filters: z.string().optional().describe("Filter JSON string, e.g. '{\"field:operator\":\"value\"}'"),
    },
    async ({ account, site_id, filters }) => {
    try {
      const query = { site_id, ...(filters ? { filters: parseJsonParam(filters, "filters") } : {}) };
      const data = await api(account, "GET", `/sites/${site_id}/firewall/logs/bots-data`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallWhitelistIps: POST /sites/{site_id}/firewall/whitelist-ips ──
  server.tool(
    "do_site_firewall_whitelist_ips",
    "Add IPs to whitelist",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesFirewallWhitelistIps."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/firewall/whitelist-ips`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesFirewallWhitelistIps: DELETE /sites/{site_id}/firewall/whitelist-ips ──
  server.tool(
    "delete_site_firewall_whitelist_ips",
    "Remove IPs from whitelist",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesFirewallWhitelistIps."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "DELETE", `/sites/${site_id}/firewall/whitelist-ips`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesPerformanceReports: GET /sites/{site_id}/performance/reports ──
  server.tool(
    "get_site_performance_reports",
    "Get Lighthouse report for a site",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/performance/reports`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesPerformanceSettings: GET /sites/{site_id}/performance/settings ──
  server.tool(
    "get_site_performance_settings",
    "Get performance settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/performance/settings`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesPerformanceSettings: PUT /sites/{site_id}/performance/settings ──
  server.tool(
    "update_site_performance_settings",
    "Update performance settings",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesPerformanceSettings."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "PUT", `/sites/${site_id}/performance/settings`, { body: reqBody, query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackupRestores: GET /sites/{site_id}/backup-restores/options ──
  server.tool(
    "get_site_backup_restores_options",
    "Get restore options",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    },
    async ({ account, site_id }) => {
    try {
      const query = { site_id };
      const data = await api(account, "GET", `/sites/${site_id}/backup-restores/options`, { query });
      return ok(fmt(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackupRestores: POST /sites/{site_id}/backup-restores ──
  server.tool(
    "initiate_site_backup_restores",
    "Initiate backup restore",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesBackupRestores."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/backup-restores`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackupDownloads: POST /sites/{site_id}/backup-downloads ──
  server.tool(
    "initiate_site_backup_downloads",
    "Initiate backup download",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesBackupDownloads."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/backup-downloads`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesBackupUploads: POST /sites/{site_id}/backup-uploads ──
  server.tool(
    "initiate_site_backup_uploads",
    "Initiate backup upload to Dropbox",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesBackupUploads."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/backup-uploads`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );


  // ── SitesMigrations: POST /sites/{site_id}/migrations ──
  server.tool(
    "initiate_site_migrations",
    "Initiate migration",
    {
    account: z.string().describe("Account name from list_accounts."),
    site_id: z.string().describe("site id"),
    site_id: z.string().describe("Site ID."),
    body: z.string().describe("Request body as JSON string. See WP Remote API docs for SitesMigrations."),
    },
    async ({ account, site_id, body }) => {
    try {
      const reqBody = parseJsonParam(body, "body");
      const query = { site_id };
      const data = await api(account, "POST", `/sites/${site_id}/migrations`, { body: reqBody, query });
      return ok(fmtTask(data, account));
    } catch (e) {
      return err(e.message);
    }
    }
  );

  return server;
}

// ── Transport Setup ─────────────────────────────────────────────────────────
async function main() {
  if (TRANSPORT === "stdio") {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[Transport] stdio connected");
  } else {
    const app = express();
    const sessions = {};

    app.use(express.json());

    app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        server: "wpremote-mcp-server",
        version: "1.0.0",
        accounts: Object.keys(accounts).length,
        timestamp: new Date().toISOString(),
      });
    });

    // Streamable HTTP transport
    app.post("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] || randomUUID();

      if (!sessions[sessionId]) {
        const srv = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
        sessions[sessionId] = { transport, server: srv };

        transport.onclose = () => {
          delete sessions[sessionId];
          srv.close().catch(() => {});
          console.error(`[Session] Closed: ${sessionId}`);
        };

        await srv.connect(transport);
        console.error(`[Session] New: ${sessionId}`);
      }

      const { transport } = sessions[sessionId];
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || !sessions[sessionId]) {
        return res.status(400).json({ error: "No session. POST to /mcp first." });
      }
      const { transport } = sessions[sessionId];
      await transport.handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId && sessions[sessionId]) {
        const { transport, server: srv } = sessions[sessionId];
        await transport.handleRequest(req, res);
        delete sessions[sessionId];
        srv.close().catch(() => {});
      } else {
        res.status(404).json({ error: "Session not found." });
      }
    });

    app.listen(PORT, () => {
      console.error(`[Transport] HTTP listening on port ${PORT}`);
      console.error(`[Transport] Health: http://localhost:${PORT}/health`);
      console.error(`[Transport] MCP:    http://localhost:${PORT}/mcp`);
    });
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
