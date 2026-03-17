## Goal
Implement all improvements from the code review of pi-telegram.

## Checklist

### Bugs / correctness
- [ ] 1. Replace inline type in `handleTelegramUpdate` with `TelegramUpdate` from types.ts
- [ ] 2. Fix startup race: send startup message *before* starting poll loop
- [ ] 3. Fix reconnection spinner gap: keep `pollRequestInFlight = true` during retry sleep
- [ ] 4. Clean up footer status on session_shutdown
- [ ] 5. Make `captureSetupOffset` retry on 409
- [ ] 6. Note shallow merge limitation in config (or deep-merge)
- [ ] 7. Add progress edit throttle (min 2s between edits)

### Structural
- [ ] 8. Split src/index.ts into relay.ts, commands.ts, queue.ts
- [ ] 9. Refactor handleTelegramUpdate into dispatch chain
- [ ] 10. Fix acceptTelegramPrompt fallthrough on idle dispatch failure
- [ ] 11. Remove unused config exports

### Polish
- [ ] 12. Remove unnecessary `{ action: "continue" }` return from input handler
- [ ] 13. Increase health timer to 200ms
- [ ] 14. Simplify RemoteCommandResult to boolean
- [ ] 15. Edit-in-place or skip duplicate startup messages
- [ ] 16. Remove unnecessary sort on queue insert
- [ ] 17. Use proper pi message types in extractAssistantText where possible

### Finalize
- [ ] 18. Parse-check all files
- [ ] 19. Update docs (.memory, README, SETUP, AGENTS)
- [ ] 20. Commit and push
