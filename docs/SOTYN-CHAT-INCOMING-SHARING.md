# SOTYN Chat incoming sharing: audit and implementation

Audit date: 8 October 2026. Scope: SOTYN Chat only. Local implementation; no production deployment or production messages were used for validation.

## Architecture found

| Area | Existing implementation | Reused / added |
| --- | --- | --- |
| Chat UI | `client/src/pages/SiteChat.jsx`; personal conversations, groups, forwarding, search | Reused conversation list and message renderer; added lightweight `/site-chat/share` picker |
| Data | Dedicated `data/chat.db`: `chat_groups`, `chat_group_members`, `chat_messages`, `chat_reads` | Messages remain in the same tables. Two additive tables track upload ownership and send receipts |
| API and permissions | Authenticated `/api/site-chat`; members plus existing admin group oversight; private DMs remain participant-only | Share routes inherit authentication and the existing module switch, and use the same access predicate. Archived chats reject sends |
| Attachments | Generic authenticated uploads; `storage.js` local/S3 adapter. Existing chat upload URLs are publicly readable | Reused adapter with a private chat namespace and authenticated file routes for **new incoming shares**. Old attachments are untouched |
| Live delivery | Socket.IO `emitChat`, read markers, `chatPush.notifyChat` | Same events and notifications after a successful transaction; replay never sends another event |
| Mobile | Installable manifest + push service worker | No Android, iOS, Capacitor, Cordova or other native app project found in this repository |

Missing before this change: incoming share target, incoming-content picker, durable offline drafts, account binding for those drafts, private incoming-share file ownership, and idempotent multi-conversation sends.

## Platform support and safest implementation path

The web implementation receives supported content through the Web Share Target API in an **installed compatible PWA**, including Android Chrome. It is not a native Android APK or an iOS Share Extension. A normal browser tab cannot register itself as an OS share destination. The sender must explicitly choose Share; no WhatsApp chats, contacts or media library are read automatically. WhatsApp's own UI determines which content it offers to the OS share sheet.

The manifest advertises text, PDF, JPG/JPEG, PNG, GIF, WebP, TXT and Office documents. It does not advertise unsupported audio/video/HEIC types. Some platforms or sending apps may offer fewer types. The installed app name is SOTYN, with proper PNG install icons. An existing installation may need its manifest refreshed or reinstallation before its share destination updates.

No native project has been supplied. When one is available:

- Android: add `ACTION_SEND` / `ACTION_SEND_MULTIPLE` filters for the supported MIME types to the existing app. Read only granted `content://` streams, enforce the same size limits, and copy them into the app's private draft storage. Use the existing authenticated session, picker and share API. Do not place tokens or attachment contents in deep links. Native receiver activities must validate incoming intents; URI grants should not outlive their purpose.
- iOS: add a Share Extension target to the existing signed app. Use `NSItemProvider` for the explicitly provided items, an App Group for temporary drafts, and the app's approved Keychain/session sharing mechanism. The extension or host app must show the picker/preview and require explicit Send. iOS extension lifecycle, entitlements, expiry and upload recovery need device testing with the actual Xcode project; the PWA does not replace this target.
- Do not create a second message database or expose credentials through a generic WebView bridge. Both adapters can call the same APIs below using the existing server-issued authentication.

Primary platform references: [Chrome Web Share Target](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target), [Android receiving shared data](https://developer.android.com/develop/ui/compose/sharing/receive), [Apple Share Extensions](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html).

## Implemented flow

1. `POST /site-chat/share-target` is intercepted by the service worker. Only the `title`, `text`, `url` and `files` provided by that share are read. Shared URLs are treated as text and never fetched by the server.
2. Content is stored in device IndexedDB. A redirect contains only a random draft ID. No file or message is uploaded yet.
3. Sign-in returns to that exact draft. On first authenticated open the draft binds to that account. Another account cannot resume it. The picker displays the sending account and searches the existing `/api/site-chat/groups` list, including pagination.
4. The user previews content and selects up to 10 existing conversations. Images render thumbnails; TXT has a text preview; PDFs use a sandboxed PDF preview with a file-opening fallback. Office files show filename/size and can be opened in the user's document viewer.
5. Explicit Send saves an immutable retry payload, uploads each selected file, and sends through the existing Chat backend. A message with text and the first attachment is followed by attachment messages when more than one file is selected.
6. All destination permissions are checked before any message is inserted. Messages, read markers and the send receipt commit atomically. Normal Chat live events and push notifications follow the commit.
7. After a lost response, Retry reuses upload IDs and the send request ID. It returns the original receipt without inserting messages or emitting notifications again. Changed payloads under an already-used ID return 409.

## API contract

All endpoints are under the existing authenticated, module-enabled `/api/site-chat` router:

| Endpoint | Contract |
| --- | --- |
| `GET /groups?limit=30&q=...` | Existing authorized conversation search; `hasMore` / `nextCursor` are reused |
| `POST /share/uploads/:uploadKey` | Multipart field `file`; client-generated UUIDv4 upload key. Returns owned attachment ID/name/MIME/size. Same key + same file returns the original upload; changed bytes/name return 409 |
| `POST /share/send` | `{request_id, expected_sender_id, group_ids, text, attachment_ids}`. UUIDv4 request ID, current account ID, conversation IDs, text, and owned upload IDs. Returns `{request_id, groups, message_ids, replayed}` |
| `GET /share/files/:id/:name` | Existing auth token required. Upload owner or current authorized recipient only; private/no-store, nosniff and attachment disposition |
| `DELETE /share/uploads/:id` | Owner may remove an unused upload. Any message reference prevents deletion |

The ordinary Chat send/forward routes additionally check access whenever a **new private share attachment** is supplied, preventing someone from forwarding another user's protected file by guessing its URL. Old upload URLs retain their existing behavior.

## Security, storage and failure handling

- New private files use `data/chat-private/`, outside the public uploads directory. Storage adapter calls use `NS.CHAT_PRIVATE`; S3 keys live under the equivalent `chat-private/` namespace.
- S3 sharing is disabled unless `CHAT_SHARE_PRIVATE_BUCKET=true` and `S3_PUBLIC_BASE_URL` is absent. Before opting in, verify anonymous bucket/object access is blocked for this namespace. This flag is an administrator assertion, not an automatic bucket-policy audit. Local private storage needs no opt-in.
- Keep `data/chat.db` and `data/chat-private/` in backups together. With S3, include the private namespace in bucket backup/retention policies. The existing public-upload orphan sweep does not traverse this private namespace.
- File limit: 20 MB each, 10 files per share, 50 MB total. Supported extensions and file signatures are checked server-side; filenames and storage keys are sanitized/generated. Signatures are format checks, not an antivirus guarantee. Office/PDF files are not executed or parsed by the server. Integrate the organization's malware scanner separately if one is required.
- Documents load only on demand in Chat. Images load near the visible area. Authenticated bytes become temporary browser blob URLs; JWTs never appear in attachment links.
- Per-user upload/send rate limits and a 100 MB pending-upload allowance bound abuse. Unused server uploads older than 24 hours are cleaned in bounded batches on subsequent uploads. Referenced attachments remain available with message history.
- Local drafts last 24 hours, with at most 5 drafts / 100 MB per browser. Expired drafts are removed on receiver/list access. Signing out preserves owned drafts for recovery, while another account is denied access. Drafts received while signed out bind to the account the user chooses at sign-in.
- No automatic background send occurs. Offline uploads retain the draft and resume through an explicit Retry after connectivity returns. An offline navigation shows a small recovery page instead of caching the whole ERP or authenticated responses.
- A send that may already have committed stays immutable. Closing its local draft does not recall messages. SQLite keeps durable receipt IDs; do not prune them casually, since delayed retries must not duplicate messages.
- Live notification dispatch follows the existing Chat process model, not a new durable outbox. A process crash between database commit and event dispatch can leave a committed message to be picked up on the existing Chat refresh; adding a cross-chat outbox is outside this scoped change.

## Validation and rollout

Automated command (use the repository's compatible Node version, Node 22 in this workspace):

```sh
node --test server/lib/__tests__/chatShare.test.js server/lib/__tests__/chatPush.test.js server/lib/__tests__/chatNotificationRead.test.js
cd client && npm run build
```

15 server/worker and existing notification tests pass: atomic multi-target sends, duplicate retries, altered payloads, private DM/admin checks, archived/removed membership, foreign attachment ownership, protected downloads, invalid file signatures, upload retries, cleanup, rollback, service-worker routing and unchanged push handling. Tests use an in-memory database and temporary files, never the ERP database.

Browser storage harness: `client/tests/chatShare.browser.html` (serve only from a local test host alongside the share store). Ten checks cover persisted file bytes, account binding, immutable retry payload, stable request IDs, invalid/empty content, expiry and cleanup. The optional simulation buttons require a synthetic local preview host; they are never part of the production bundle.

Local browser checks additionally cover receiving a synthetic share through the service worker, searching/selecting multiple chats, reload persistence, explicit send, delivery into the existing Chat UI, and a lost-response retry with unchanged message/upload/notification counts. Session and offline recovery are checked in the isolated preview.

Before production rollout, test on physical supported Android devices with an installed staging PWA and actual WhatsApp text, image, PDF and document shares. Check cold/warm start, multi-file shares, revoked permissions, interrupted upload, expired login and low storage. Native APK/iOS sharing remains pending the actual native project and device tests. Deploying this web change alone cannot make an iOS PWA appear as a Share Extension.

Deploy backend, frontend, service worker and public assets together after staging acceptance. Schema changes are additive. Keep the new authenticated file route/renderer when rolling back share creation if any new attachments have already been sent, so existing messages retain access to those files. Production has not been modified by this task.
