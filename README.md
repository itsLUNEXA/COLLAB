# Collaborative AI Coding Platform

A high-performance, contract-first collaborative coding platform designed for multi-developer teams and hackathons using Google Antigravity IDE.

## Packages (Phase 1 Foundation)

- `@collab/protocol` ([packages/protocol](packages/protocol)): Authoritative wire protocol schemas, operation types, path jailing, editing leases, and checkpoint models.
- `@collab/contract-guard` ([packages/contract-guard](packages/contract-guard)): Semantic contract validators (OpenAPI 3.1, JSON Schema, TypeScript AST) and breaking change diff engine.
- `@collab/db` ([packages/db](packages/db)): PostgreSQL relational schemas and migration files for multi-tenant teams, devices, events, versioned contracts, leases, and checkpoints.

## Development Commands

```bash
# Install workspace dependencies
npm install

# Build all packages with project references
npm run build

# Run TypeScript type-checking
npm run typecheck

# Run unit tests across all packages
npm test
```
