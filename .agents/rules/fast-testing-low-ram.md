# FAST TESTING, LOW RAM, MINIMAL WAIT POLICY

Apply these rules strictly across all development phases:

1. **High-Value Tests Only:** Write targeted, critical tests only (auth, sync, conflict protection, contract validation, GitHub publishing). No redundant tests.
2. **Targeted Execution:** Test only the affected module after a change (e.g. `npx vitest run path/to/test.ts`).
3. **Limit Routine Checks:** Run single targeted test command and typecheck only when relevant. Do not re-run entire suites on minor edits.
4. **RAM & Process Management:** Avoid parallel workers (`--maxWorkers=1` / single-threaded where needed), avoid duplicate background servers, clean up dangling processes.
5. **Bounded Timeouts:** Enforce explicit timeouts (max 5-10s per test). Never wait indefinitely on hung sockets or servers.
6. **Concise Reporting:** Report exact tests run, pass/fail status, execution time, and any skipped checks honestly. Never claim untested code is verified.
