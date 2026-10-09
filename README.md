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

The sidebar's **Appearance** menu offers **Light**, **Dark**, and **System**. System is the initial setting and follows changes to your device's color scheme automatically. Your selection is saved in this browser for this app address and shared between its open tabs. Appearance remains available during replies and while signed out.

## How it works

The Node server implements the documented Sign in with ChatGPT flow directly: dynamic client registration, authorization code with PKCE, state and nonce validation, signed OIDC identity validation using `jose`, serialized token refresh, and session revocation. It does not read an existing Codex login. It verifies the granted `chatgpt.tokens.use.direct` scope before inference.

Requests use the public Responses API with `store: false` and `stream: true`. Each chat replays its own input history, including encrypted reasoning items. A conversation turn is saved only after `response.completed`. No tools are exposed to the model.

In `.data/chats.json`, each new assistant message has a `metadata` object containing the request settings (without duplicate input history), local start/finish timestamps, HTTP status and response headers, the unmodified API response object, and every parsed stream event. This preserves model, reasoning effort, service tier, usage, IDs, provider timestamps, annotations, null values, and unknown future fields. Requested settings and reported values are kept separately. Authorization and cookie headers are excluded; request credentials are never archived. Stream events can make this file substantially larger than the visible chat text.

Failed, incomplete, interrupted, or cancelled requests retain their available metadata and error in the chat's `failedAttempts` array, without adding a conversation turn or changing the input history. Metadata survives restarts but is not included in ordinary browser chat payloads or replayed as model input. The GUI still displays only chat text. Older messages retain their existing data; metadata discarded before this change cannot be recovered.

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
