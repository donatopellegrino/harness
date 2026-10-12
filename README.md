# Basic Harness

A minimal local chat harness: Continue with ChatGPT, open separate chats, choose a model and reasoning effort, and send messages with streamed replies.

## Run

Requires Node.js 22 or later.

```sh
npm install
npm start
```

Open the printed loopback URL (normally `http://127.0.0.1:43187`) in Chrome. Choose **Continue with ChatGPT** and authorize this app to use your ChatGPT plan. The picker shows the full account catalog plus GPT-6.1 Sol, GPT-6 Sol, and GPT-6 Luna, which can be usable even when omitted from the catalog. **Custom model…** accepts other model IDs; OpenAI checks access for each request. **Default** effort omits the effort parameter; the model selects its default. Explicit options use catalog metadata where provided, documented GPT-6 settings, or common reasoning levels for custom IDs; the API remains authoritative for model support.

To use another local port: `PORT=0 npm start` chooses an unused port, or `PORT=43210 npm start` selects one. Only `127.0.0.1` is bound.

The **⚡ Fast** button toggles Fast mode for the current chat and remembers that choice. It keeps the chosen reasoning effort and sends `service_tier: "priority"` (the Fast mode alias accepted by the ChatGPT plan endpoint) when on, or `"default"` when off. Existing and new chats start with Fast mode off. Speed and access depend on the model and account. Fast mode consumes more plan allowance; see [OpenAI's speed guide](https://learn.chatgpt.com/docs/agent-configuration/speed). Provider errors remain visible so you can turn it off and retry.

If OpenAI reports Standard processing despite a Fast request, the completed reply is saved and the page displays a notice. Requesting Fast mode does not guarantee that OpenAI will serve that tier.

Beside **Send**, hold **Effort ↑**, drag onto an effort in the menu above it, and release to send using that effort. Releasing outside the choices cancels. The menu uses the selected model's effort options; the chosen effort becomes the chat's current setting. With a keyboard, activate **Effort ↑**, use the arrow keys, and press Enter to send (Escape cancels).

Chats, selections, host identity, and credentials persist in the ignored `.data/` folder. Credentials stay in the Node process and protected local files (directory mode `0700`, files `0600`); they are never returned to browser code. Chat text is rendered as plain text.

Each **You** and **Assistant** label has an **ⓘ** button. Hover or focus it to see message metadata; click or tap to keep the panel open, and close it with **×**, Escape, or a click outside. The summary shows requested and reported settings, token usage, timing, and response identifiers. Scroll through the open sections for all readable saved fields, including HTTP details, annotations, stream event types/sequences, and future provider fields; sections can be collapsed. Metadata loads only when you open the panel. New user messages record their request settings and request start time. Older user messages recover these from their paired reply when available, with the source explicitly labeled. Older messages with no metadata say so; in-progress messages show a pending notice.

The metadata endpoint removes encrypted reasoning/compaction state, binary/media data and large opaque encoded strings, credentials/authentication headers, repeated conversation input, and repeated message text/text deltas. Excluded fields are marked and counted in the panel. IDs, readable reasoning summaries, annotations, numbers, booleans, nulls, and unknown readable fields remain available. Original provider metadata is still saved unchanged locally; the filtering applies only to the browser view.

The Editorial interface uses warm light and dark palettes, a compact sidebar and toolbar, and wider conversation text. The composer grows as you type up to 220 px (or 28% of the viewport on smaller screens), then scrolls internally; it has no manual resize handle. Dropdown arrows have consistent inset spacing.

The sidebar supports nested folders. Select **Top level** or a folder, then use **New folder** or **New chat** to create an item there. Expand/collapse folders with the arrow. Click a folder or chat to select it; click the selected item again to rename it. Existing folders stay in their original parent; only new folders have a parent choice. Chat dialogs also let you change the chat’s folder. You can also use the keyboard to activate the selected item. Working indicators appear beside generating/compacting chats and every ancestor folder, including collapsed folders. They show activity rather than a fabricated completion percentage and refresh from the server while the page is visible. Names and chat locations can be changed while a reply or compaction is running; a custom chat name is preserved when its first reply completes. Existing chats start at the top level. Folder structure is saved in `.data/folders.json`; each chat's name and folder are saved in `.data/chats.json` and survive restarts.

The sidebar's **Appearance** menu offers **Light**, **Dark**, and **System**. System is the initial setting and follows changes to your device's color scheme automatically. Your selection is saved in this browser for this app address and shared between its open tabs. Appearance remains available during replies and while signed out.

Below the composer, **Compact context** requests manual compaction without deleting the visible transcript or sending your draft. During the request the page shows **Compacting context…** and locks chat controls. Very short chats may have nothing to compact: OpenAI requires a compaction threshold of at least 1,000 tokens. Unsupported models, failed requests, cancellation, or missing checkpoints leave the active history unchanged.

If a manual stream is interrupted, the page checks saved chat state before reporting the outcome: a lost acknowledgment can happen after compaction was already saved. It refreshes the transcript, usage, and compaction count while preserving your draft. If saved state cannot be fetched, it asks you to reload and check before retrying rather than claiming the history was unchanged.

Every ordinary reply configures server-side compaction at **40% of the selected model's account catalog `max_context_window`**. The current catalog gives 348,800 tokens for an 872,000 maximum and 108,800 for a 272,000 maximum. OpenAI checks the rendered context during the request, including the newly sent message; the harness does not estimate tokens from character counts. When the maximum is missing or 40% of it is below the supported 1,000-token threshold, automatic compaction is unavailable and the page says so. There is no fallback to `context_window` or a published API limit.

The **Last request** meter compares the last completed request's usage with that catalog maximum. Expand it for input, output, cached input, and reasoning counts. Reasoning is already included in output; it is not counted twice. These are historical API usage counts, not a live count of context after compaction: draft text is excluded, usage may include the pre-compaction input, and the next request's count may differ. Switching models hides the percentage until usage matches the selected model. Catalog maxima are reported values, not verified hard input limits.

## How it works

The Node server implements the documented Sign in with ChatGPT flow directly: dynamic client registration, authorization code with PKCE, state and nonce validation, signed OIDC identity validation using `jose`, serialized token refresh, and session revocation. It does not read an existing Codex login. It verifies the granted `chatgpt.tokens.use.direct` scope before inference.

Requests use the public Responses API with `store: false` and `stream: true`. Each chat replays its own input history, including encrypted reasoning items. A conversation turn is saved only after `response.completed`. No tools are exposed to the model.

Compaction uses `context_management: [{ type: "compaction", compact_threshold: ... }]` on the Responses route, which is available to this ChatGPT credential. The standalone `/responses/compact` endpoint is not used. Manual requests use a threshold of 1,000 with the chat's model, effort, and Fast setting. They add no temporary instructions or user message; the extra generation is archived as maintenance metadata and is not displayed or replayed. Successful manual compaction keeps the encrypted checkpoint as active input. Ordinary replies retain the latest checkpoint and all subsequent output. All pruning is committed atomically only after the response completes and the checkpoint is validated.

The Responses stream signals the returned compaction item, not an exact start event. Automatic requests show **Compacted context received** when that item arrives, then confirmation after it is saved. Manual requests show progress from the moment you press the button. Compaction can lose details; the complete visible transcript and previously saved response metadata remain in local storage.

In `.data/chats.json`, each new assistant message has a `metadata` object containing the request settings (without duplicate input history), local start/finish timestamps, HTTP status and response headers, the unmodified API response object, and every parsed stream event. This preserves model, reasoning effort, service tier, usage, IDs, provider timestamps, annotations, null values, and unknown future fields. Requested settings and reported values are kept separately. Authorization and cookie headers are excluded; request credentials are never archived. Stream events can make this file substantially larger than the visible chat text.

The `compactions` array records successful manual and automatic compactions and archives their superseded `previous_input`, including opaque state from older chats. Manual entries include their complete request/response metadata; automatic metadata remains attached to the corresponding assistant reply. The `input` array contains only the active context for replay, while `messages` preserves the transcript. Both survive restarts. Failed manual requests are recorded in `failedAttempts` with `operation: "compaction"`.

Failed, incomplete, interrupted, or cancelled requests retain their available metadata and error in the chat's `failedAttempts` array, without adding a conversation turn or changing the input history. Metadata survives restarts but is not included in ordinary browser chat payloads or replayed as model input. A small numeric usage summary is returned for the Context indicator; the message-info endpoint returns a filtered projection on demand. Older messages retain their existing data; metadata discarded before this change cannot be recovered.

```sh
npm run check
npm test
```

Automated tests use simulated OAuth and Responses servers, not your subscription. Real sign-in and inference require user consent and account eligibility.

## Official references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Reasoning effort](https://developers.openai.com/api/docs/guides/reasoning)
- [Compaction](https://developers.openai.com/api/docs/guides/compaction)
