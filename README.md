# Basic Harness

A minimal local chat harness: Continue with ChatGPT, open separate chats, choose a model and reasoning effort, and send messages with streamed replies.

Organization is a hierarchy of containers and chats; chats are leaves. A chat belongs to the container selected when it is created, or to the top level. Existing chats and containers cannot be moved. Parentage is protected by the API and SQLite triggers, with regression tests and the product rules in `AGENTS.md` keeping this restriction explicit.

Click an already selected chat again to open its edit dialog. **Archive chat** hides it from the folder tree; **Archived chats** in the sidebar opens a flat list where you can read it and use **Restore chat** to return it to its original folder. Archived chats cannot generate replies, compact, or change model settings until restored. Renaming remains available; archive/restore never changes the chat's container.

**Delete permanently…** asks “Are you sure?” before removing the chat. Deletion runs in a SQLite transaction and cascades to all its message, input/context, compaction, failed-attempt, and shared-payload rows; it is not a soft delete and has no undo. Other chats, folders, and account state are preserved. Chats that are currently working cannot be archived, restored, or deleted. Historical database backups are independent files and are not modified by chat deletion; this feature does not claim forensic erasure of disk pages or backup copies.

## Chat URLs

Saved chats have stable URLs at `/chats/<id>`. Selecting or creating a chat updates the address; opening the URL directly or refreshing selects that conversation and reveals its folder. Sidebar chat names are links, so copying a link and opening it in another tab work normally. Clicking the selected chat again still opens its rename dialog. Renaming does not change the URL.

Browser Back/Forward selects the corresponding conversation. During a reply, compaction, or settings save, navigation waits until that request finishes. Archived links open the archive view with the chat read-only. Missing/deleted chat links show an unavailable message instead of selecting another chat.

Private chats keep the generic `/` address: private IDs, titles, and context never enter URL or browser history state. Private conversations remain temporary and cannot be reopened from a link.

## Private chats

**Private chat** opens a temporary conversation in the selected folder. It receives the same global and immediate-folder AGENTS.md instructions as a normal chat. A distinct sidebar label and banner identify it. Use **Close private chat** to discard it; switching to another chat keeps it available in the same tab. Click a selected private chat again to rename it in memory. Private chats cannot be archived or converted to saved chats.

Conversation text, active context, encrypted reasoning, compaction state, and message metadata live only in backend memory. They are never written to SQLite, browser storage, or application logs. The page holds an opaque access capability and display data in memory; other tabs cannot discover private chats through shared APIs. Reloading, navigating away, signing out, closing the tab, or entering the browser's back/forward cache forgets that capability. The metadata popup does not cache private metadata.

The backend owns private generation and compaction, just as it owns saved-chat operations. Closing the page or losing its stream does not cancel work. Explicitly closing a private chat immediately removes access; active work finishes and its result is discarded. Otherwise, inactive private chats expire after 5 minutes, with cleanup performed by the backend. Active operations never expire, and completion starts a fresh idle period. Backend restart loses private chats. Private context stays on the backend and is not supplied or replayed by the browser. Individual user messages retain the ordinary 32,000-character limit.

Messages still go to OpenAI and consume plan usage. Requests use the existing `store: false`; private mode makes no additional promise about OpenAI's retention policies. Account credentials and AGENTS.md settings remain persisted normally, independently of private chat contents.

## Chat AGENTS.md

Use **Global AGENTS.md** in the sidebar to edit instructions for every chat. To edit one folder's instructions, click an already selected folder again and choose **Edit folder AGENTS.md**. Markdown is saved as plain text in the SQLite `agents_md` table, with a revision and update time. Empty text clears that scope; documents are limited to 32,000 characters. Concurrent saves reject stale revisions and keep the editor's draft.

Each model request receives only the current global document plus the document belonging to the chat's immediate folder. There is no ancestor, descendant, sibling, or filesystem lookup. Top-level chats receive only global instructions; an empty folder document does not inherit a parent's document. Folder rules take precedence in conflicts with global rules. This database feature is separate from the repository's development `AGENTS.md`.

The harness resends current instructions using the Responses API `instructions` parameter on every reply and manual compaction request, including after automatic compaction. Edits apply to new requests in existing chats; running requests keep their snapshot. Exact sent instructions remain in request metadata, with the source folder IDs and revisions recorded in `agents_md` metadata. Editing instructions does not erase their prior influence from saved replies or opaque compacted context. Instruction text is not appended to the visible transcript or active replay array. See [OpenAI's instructions documentation](https://developers.openai.com/api/docs/guides/text#message-roles-and-instruction-following).

Existing databases gain the empty instruction table at startup without rewriting conversations or changing hierarchy. No instruction text is imported automatically from host or repository files.

## Run

Requires Node.js 22.13 or later (uses the built-in SQLite driver).

```sh
npm install
npm start
```

Open the printed loopback URL (normally `http://127.0.0.1:43187`) in Chrome. Choose **Continue with ChatGPT** and authorize this app to use your ChatGPT plan. The picker shows the full account catalog plus GPT-6.1 Sol, GPT-6 Sol, and GPT-6 Luna, which can be usable even when omitted from the catalog. **Custom model…** accepts other model IDs; OpenAI checks access for each request. **Default** effort omits the effort parameter; the model selects its default. Explicit options use catalog metadata where provided, documented GPT-6 settings, or common reasoning levels for custom IDs; the API remains authoritative for model support.

To use another local port: `PORT=0 npm start` chooses an unused port, or `PORT=43210 npm start` selects one. Only `127.0.0.1` is bound.

The **⚡ Fast** button toggles Fast mode for the current chat and remembers that choice. It keeps the chosen reasoning effort and sends `service_tier: "priority"` (the Fast mode alias accepted by the ChatGPT plan endpoint) when on, or `"default"` when off. Existing and new chats start with Fast mode off. Speed and access depend on the model and account. Fast mode consumes more plan allowance; see [OpenAI's speed guide](https://learn.chatgpt.com/docs/agent-configuration/speed). Provider errors remain visible so you can turn it off and retry.

If OpenAI reports Standard processing despite a Fast request, the completed reply is saved and the page displays a notice. Requesting Fast mode does not guarantee that OpenAI will serve that tier.

Beside **Send**, hold **Effort ↑**, drag onto an effort in the menu above it, and release to send using that effort. Releasing outside the choices cancels. The menu uses the selected model's effort options; the chosen effort becomes the chat's current setting. With a keyboard, activate **Effort ↑**, use the arrow keys, and press Enter to send (Escape cancels).

Chats, selections, host identity, and credentials persist in the ignored `.data/storage.sqlite` database. Credentials stay in the Node process and protected local files (directory mode `0700`, files `0600`); they are never returned to browser code. Chat text is rendered as plain text.

Each **You** and **Assistant** label has an **ⓘ** button. Hover or focus it to see message metadata; click or tap to keep the panel open, and close it with **×**, Escape, or a click outside. The summary shows requested and reported settings, token usage, timing, and response identifiers. Scroll through the open sections for all readable saved fields, including HTTP details, annotations, stream event types/sequences, and future provider fields; sections can be collapsed. Metadata loads only when you open the panel. New user messages record their request settings and request start time. Older user messages recover these from their paired reply when available, with the source explicitly labeled. Older messages with no metadata say so; in-progress messages show a pending notice.

The metadata endpoint removes encrypted reasoning/compaction state, binary/media data and large opaque encoded strings, credentials/authentication headers, repeated conversation input, and repeated message text/text deltas. Excluded fields are marked and counted in the panel. IDs, readable reasoning summaries, annotations, numbers, booleans, nulls, and unknown readable fields remain available. Original provider metadata is still saved unchanged locally; the filtering applies only to the browser view.

The Editorial interface uses warm light and dark palettes, a compact sidebar and toolbar, and wider conversation text. The composer grows as you type up to 220 px (or 28% of the viewport on smaller screens), then scrolls internally; it has no manual resize handle. Dropdown arrows have consistent inset spacing.

The sidebar supports nested folders. Select **Top level** or a folder, then use **New folder** or **New chat** to create an item there. Expand/collapse folders with the arrow. Click a folder or chat to select it; click the selected item again to rename it. Existing folders stay in their original parent; only new folders have a parent choice. You can also use the keyboard to activate the selected item. Working indicators appear beside generating/compacting chats and every ancestor folder, including collapsed folders. They show activity rather than a fabricated completion percentage and refresh from the server while the page is visible. Names can be changed while a reply or compaction is running; a custom chat name is preserved when its first reply completes. Existing chats start at the top level. Folder structure and chat names are stored in SQLite and survive restarts.

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

Completed compactions also leave timestamped dividers in the conversation. Automatic compaction is marked after the reply that returned the checkpoint; manual compaction is marked at the current end of the transcript. The displayed time is the saved request completion time. New records save an explicit message boundary; older records use response IDs or adjacent known timestamps where possible, otherwise the marker says its position was not recorded. Markers survive reloads and do not become messages sent to the model.

In SQLite's message records, each new assistant message has a `metadata` object containing the request settings (without duplicate input history), local start/finish timestamps, HTTP status and response headers, the unmodified API response object, and every parsed stream event. This preserves model, reasoning effort, service tier, usage, IDs, provider timestamps, annotations, null values, and unknown future fields. Requested settings and reported values are kept separately. Authorization and cookie headers are excluded; request credentials are never archived. Stream events can make the database substantially larger than the visible chat text.

The `compactions` array records successful manual and automatic compactions and archives their superseded `previous_input`, including opaque state from older chats. Manual entries include their complete request/response metadata; automatic metadata remains attached to the corresponding assistant reply. The `input` array contains only the active context for replay, while `messages` preserves the transcript. Both survive restarts. Failed manual requests are recorded in `failedAttempts` with `operation: "compaction"`.

Failed or incomplete provider requests retain their available metadata and error in the chat's `failedAttempts` array, without adding a conversation turn or changing the input history. Metadata survives restarts but is not included in ordinary browser chat payloads or replayed as model input. A small numeric usage summary is returned for the Context indicator; the message-info endpoint returns a filtered projection on demand. Older messages retain their existing data; metadata discarded before this change cannot be recovered.

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

## Backend operations

Sending a message or compacting context submits a command to the backend. The backend accepts it with an operation ID and HTTP 202, owns its execution and per-chat lock, and commits its result without waiting for a browser. Different chats can work concurrently. Switching chats, closing the page, reloading, or losing connectivity only disconnects an observer. Returning to a saved chat shows its current progress or finished result. The page reconnects dropped observation streams without submitting another model request.

Commands carry an idempotency key. Repeating the same accepted command returns the original operation; reusing its key for different content is rejected. Creating a chat for its first message and recording the accepted command happen in one transaction. If an acknowledgment is lost, the page asks the backend whether that command was accepted rather than automatically resubmitting it. Settings and the current global/direct-folder instructions are captured by the backend when accepting the command.

Saved operations live in `chat_operations`, alongside normal chat records. Pending prompts, status, errors, and partial reply text survive page closure. Partial text is checkpointed at most once per 200 ms; the completed transcript, model context, metadata, and completed operation status commit together in one SQLite transaction. Completed operations remove their duplicate prompt and partial text. Permanent chat deletion also removes its operation records.

A graceful backend shutdown drains active work. A forced stop, crash, or machine restart can interrupt provider requests: at startup, unfinished saved operations become **interrupted**, retaining their last committed prompt and partial reply. Partial output is marked unfinished and is not added to model context as a completed reply. The backend does not automatically resend these requests or claim it can resume a disconnected provider stream. Private operations use the same execution manager but remain entirely in RAM.

## SQLite storage and migration

All persisted app state uses SQLite. There are no JSON or JSONL storage files after migration. Chat headers and folders have indexed rows; messages, active model context, compaction archives, and failed attempts are ordered individual records. Provider objects remain lossless JSON values inside database columns. Renames update a header, and completed replies commit their messages, context, and metadata in one transaction. The server reads saved chats from SQLite and retains only in-flight chat objects; the current `/api/state` browser payload still includes every chat's visible history.

`chat_items` stores each collection entry's order and a `payload_id`, rather than a copy of its content. `chat_payloads` stores shared records scoped to each chat. Structured records reference their child records; message text, encrypted state, and long strings are stored once and referenced wherever needed. Thus visible messages, response objects, stream events, active context, and compaction archives reuse identical content. Each stream-event array has its own record, so ordinary display reads skip its contents; small diagnostic fields stay inline within that archive. Original API objects are reconstructed losslessly before requests or metadata display; the human-readable hover exclusions are unchanged. Unreferenced records are removed in the same transaction as an update, while anything referenced by saved messages or archives is retained. This reduces repeated payloads; SQLite rows and reference records still have overhead, and unique stream deltas are still saved.

SQLite uses WAL journaling, full synchronous commits, foreign keys, and a busy timeout. The directory is owner-only (`0700`) and the database is `0600`. Use one backend process per database; the operation manager owns active work and SQLite also enforces one queued/running operation per chat. Starting a second backend against the same database is unsupported. The operations table is added automatically without rewriting existing conversation records. Appearance remains a browser preference.

For an existing installation, stop the backend first, then run:

```sh
npm run migrate
npm start
```

If the running version uses a different storage directory, pass it explicitly:

```sh
npm run migrate -- /absolute/path/to/.data
```

The migration reserves the loopback backend port (`PORT`, default `43187`) so an older backend cannot run on that port during conversion. Startup refuses legacy JSON files or SQLite formats 1 and 2 instead of silently opening storage that needs upgrading.

Migration imports all existing `.json` files in the data directory in one transaction: chats, folders, sign-in credentials, host identity, and additional diagnostic/probe files. It checks the complete imported data, creates and verifies an owner-only `storage.migration-backup-*.sqlite` snapshot, verifies source hashes, then removes the old JSON files. Extra files are retained in `app_state` under `legacy/<filename>`. A migration manifest makes cleanup retryable after interruption without importing old state over newer SQLite data. Invalid or changed sources are kept and reported.

For an existing SQLite version 1 database, the same command creates and verifies an owner-only `storage.context-backup-*.sqlite` snapshot and converts collection entries to shared records. For version 2, it creates a verified `storage.events-backup-*.sqlite` snapshot and separates inline stream-event archives into their own payloads. Both conversions check every reconstructed entry against its original value before committing format version 3. Failed conversions roll back without replacing the old data; successful upgrades are not repeated. Sign-in state, folders, chat headers, and all metadata are preserved. Interrupted version 2 JSON cleanup finishes against its original snapshot before the event upgrade begins. Finish any interrupted version 1 JSON migration with the previous build before upgrading. Previous SQLite builds reject the newer format; use this version after upgrading.

The migration snapshot includes credentials and should remain private. It is a pre-migration snapshot, not an ongoing backup. Back up a running database using SQLite's backup API; copying only `storage.sqlite` while WAL writes are active can omit pending data. Do not run an older JSON-storage build against the migrated directory: use the SQLite PR version until it is merged.
