# Antigravity IDE — MCP Context Engine Setup Guide

This guide explains how to connect two developers' local Google Antigravity IDE installations (e.g. **Maheen** working on backend and **Shivam** working on frontend) to the shared Collaborative AI Context Engine.

---

## 1. How It Works

The **Collab MCP Context Engine** exposes 7 tools directly to each developer's AI agent:
1. `get_project_context`: Authoritative view of contracts, module ownership, tasks, decisions, and system freshness.
2. `get_api_contract`: Retrievable contract definitions and breaking-change history.
3. `publish_api_contract`: Publishes contract updates, evaluates semantic diffs, and automatically marks dependent consumers as stale.
4. `get_recent_changes`: Real-time cross-developer change stream.
5. `record_project_decision`: Shared architectural memory and design rationale.
6. `claim_module_intent`: Module ownership declaration with collision warnings when teammates edit the same area.
7. `verify_integration_status`: Pre-flight checkpoint verification across contracts and merge conflicts.

---

## 2. Configuration for Both Developers

### Option A: Automatic Workspace Discovery (Recommended)
Antigravity automatically discovers and activates `.agents/mcp_config.json` when the workspace folder is opened in the IDE:

```json
{
  "mcpServers": {
    "collab-context-engine": {
      "command": "node",
      "args": ["services/collab-server/dist/mcp/cli.js"],
      "env": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

### Option B: Machine-Wide Global Configuration
Add the configuration to `~/.gemini/config/mcp_config.json` on each developer's laptop:

#### Developer A (Maheen - Backend Laptop):
```json
{
  "mcpServers": {
    "collab-context-engine": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/services/collab-server/dist/mcp/cli.js"],
      "env": {
        "COLLAB_PROJECT_ID": "<project-id>",
        "COLLAB_DEVICE_ID": "maheen-laptop"
      }
    }
  }
}
```

#### Developer B (Shivam - Frontend Laptop):
```json
{
  "mcpServers": {
    "collab-context-engine": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/services/collab-server/dist/mcp/cli.js"],
      "env": {
        "COLLAB_PROJECT_ID": "<project-id>",
        "COLLAB_DEVICE_ID": "shivam-laptop"
      }
    }
  }
}
```

### Option C: Remote HTTP / SSE Transport
When collaborating across separate physical laptops on a local network or VPN:
```json
{
  "mcpServers": {
    "collab-context-engine": {
      "serverUrl": "http://<server-ip>:3000/api/v1/mcp"
    }
  }
}
```

---

## 3. Verifying in Antigravity IDE

1. In Antigravity IDE, open **Additional Options (...) > MCP Servers**.
2. Confirm `collab-context-engine` shows status **Connected**.
3. In the chat prompt, the agent can call `get_project_context({ project_id })` to immediately retrieve shared team state.
