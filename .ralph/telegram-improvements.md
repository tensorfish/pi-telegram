## Goal
Implement all improvements from the code review of pi-telegram.

## Checklist

### Bugs / correctness
- [x] 1. Replace inline type in `handleTelegramUpdate` with `TelegramUpdate` from types.ts
- [x] 2. Fix startup race: send startup message *before* starting poll loop
- [x] 3. Fix reconnection spinner gap: keep `pollRequestInFlight = true` during retry sleep
- [x] 4. Clean up footer status on session_shutdown
- [x] 5. Make `captureSetupOffset` retry on 409
- [x] 6. Note shallow merge limitation in config (or deep-merge)
- [x] 7. Add progress edit throttle (min 2s between edits)

### Structural
- [x] 8. Split src/index.ts into relay.ts, commands.ts, queue.ts
- [x] 9. Refactor handleTelegramUpdate into dispatch chain
- [x] 10. Fix acceptTelegramPrompt fallthrough on idle dispatch failure
- [x] 11. Remove unused config exports

### Polish
- [x] 12. Remove unnecessary `{ action: "continue" }` return from input handler
- [x] 13. Increase health timer to 200ms
- [x] 14. Simplify RemoteCommandResult to boolean
- [x] 15. Edit-in-place or skip duplicate startup messages
- [x] 16. Remove unnecessary sort on queue insert
- [x] 17. Use proper pi message types in extractAssistantText where possible

### Finalize
- [x] 18. Parse-check all files
- [x] 19. Update docs (.memory, README, SETUP, AGENTS)
- [x] 20. Commit and push

All items completed in commit b097ebd.
