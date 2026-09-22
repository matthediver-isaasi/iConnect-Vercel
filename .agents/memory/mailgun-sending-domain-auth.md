---
name: Mailgun sending-domain authorization
description: Distinguish a Mailgun sending-domain mismatch from invalid credentials.
---

A Mailgun message HTTP 401 does not alone prove the API key is invalid. A valid
key can reject sends addressed to an unregistered sending domain, while domain
discovery succeeds.

**Why:** The approved visible From address need not use the domain registered
with Mailgun. Inferring the provider API domain from that address caused repeated
authorization failures despite valid test credentials.

**How to apply:** Use read-only domain discovery to establish the registered
domain and region before requesting replacement credentials. Keep the user's
approved From address separate, and do not silently change it or retry an
uncertain accepted send. Never log keys or full SDK errors.