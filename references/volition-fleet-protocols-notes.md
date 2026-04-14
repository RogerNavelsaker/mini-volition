# Volition Fleet Protocols Notes

Source: https://github.com/AIndoria/volition/blob/main/docs/Fleet_Protocols.md

Behavior cues relevant to `.fleet`:

- Channel integrity is a fleet rule: reply on the same transport layer used for contact.
- Inbox/email and synchronous chat have different response obligations.
- Mutable fleet protocols are social rules and can evolve over time.
- Logging and auditability are operational expectations, not optional extras.

How this informs `.fleet`:

- Keep reply-channel integrity hard in the harness.
- Keep wake source and response-path distinctions explicit.
- Preserve durable action and wake logs so behavior remains inspectable.
