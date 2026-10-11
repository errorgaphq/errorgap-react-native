# @errorgap/react-native

React Native notifier for [Errorgap](https://errorgap.com). Captures uncaught
JS errors and unhandled promise rejections (V8 and Hermes stack formats) and
ships notices to an Errorgap server, plus nested `Error.cause` chains,
breadcrumbs, structured logs, and APM transactions/spans. JS-side telemetry
only — pair with `errorgap-swift` / `errorgap-android` for native crashes.

Metro-served development bundles are resolved back to original TypeScript
source (file, line, function, and a source excerpt) using the bundle's source
map, so backtraces render app and vendor frames with highlighted source in the
dashboard without any repository integration.

## Install

```sh
npm install @errorgap/react-native
```

No native modules — no `pod install` or Gradle wiring needed.

## Configure

Call as early as possible in the app entry point:

```ts
import { Errorgap } from "@errorgap/react-native";
import { Platform } from "react-native";

Errorgap.init({
  endpoint:    "https://errorgap.example.com",
  projectSlug: "my-app",
  apiKey:      "<project key>",
  environment: __DEV__ ? "development" : "production",
  deviceInfo: {
    os_name: Platform.OS,
    os_version: String(Platform.Version),
  },
});
```

`init` installs `ErrorUtils.setGlobalHandler` and an unhandled-rejection hook
by default — pass `captureGlobals: false` to skip. `deviceInfo` is
caller-supplied so the package ships no native code; anything you pass is
attached to every notice.

## Manual notification

```ts
try {
  await risky();
} catch (err) {
  await Errorgap.notify(err, { context: { component: "billing" } });
  throw err;
}
```

`notify` returns a `DeliveryResult` (`{ status, body }` on success,
`{ error }` on failure, `{ queued: true, status: 202 }` in async mode). The
SDK never throws.

Nested errors are captured automatically: pass a chain built with
`new Error("…", { cause })` and each cause's type/message lands in
`context.causes` while its frames merge into the backtrace.

## Breadcrumbs

Record navigation, taps, and requests; the recent trail is attached to every
notice as `context.breadcrumbs`.

```ts
Errorgap.addBreadcrumb("navigated to Checkout", {
  category: "navigation",
  metadata: { from: "Cart" },
});
```

## Structured logs

```ts
await Errorgap.log("payment gateway timeout", "error", { source: "payments" });
```

Levels are `trace < debug < info < warn < error < fatal`; anything below
`minimumLogLevel` is dropped client-side.

## Performance (APM)

Time a screen interaction or API call and record DB/HTTP spans:

```ts
await Errorgap.trackTransaction(
  { method: "GET", path: "/orders/{orderId}", pathRaw: "/orders/123" },
  async (spans) => {
    spans.database("SELECT * FROM orders WHERE id = 123", 4.2, { function: "OrderRepo.load" });
    spans.external(88, { function: "PaymentGateway.charge" });
    await loadOrder();
  },
);
```

Background work is delivered as a `job` transaction:

```ts
await Errorgap.trackJob("ReceiptJob", async (spans) => {
  spans.database("INSERT INTO receipts …", 6);
}, { queue: "mailers" });
```

`trackTransaction`/`trackJob` time the callback and deliver on completion even
if it throws. Use `Errorgap.notifyTransaction(...)` for a pre-measured
transaction.

### Link API calls to server traces

Trace a call to your API and errorgap links it to the server request that
answered it (when the server's errorgap SDK records the `x-errorgap-trace`
header — Rails, Laravel, Express, Django, Spring and the rest do):

```ts
await Errorgap.trackTransaction({ method: "GET", path: "OrderScreen" }, async (spans) => {
  const res = await spans.traceCall("GET /api/orders/7", (headers) =>
    fetch(`${API}/orders/7`, { headers }),
  );
  // ...
});
```

`traceCall` records an `http` span carrying the trace id it sent; the app's
trace lists each traced call with a link to its server trace, and the server
trace shows how long the app waited. For manual timing use
`const call = spans.startCall(label)`, send `call.headers`, then `call.finish()`.

### Link errors to their transaction

Each transaction has an id. An error reported while exactly one
`trackTransaction`/`trackJob` callback is running carries it as
`context.transaction_id`, so errorgap shows the error that interaction raised
on its trace. React Native has no async-local storage, so when transactions
overlap no id is attached rather than a possibly wrong one; pass it explicitly
from the callback instead:

```ts
await Errorgap.trackTransaction({ path: "/checkout" }, async (spans) => {
  try {
    await submitOrder();
  } catch (error) {
    await Errorgap.notify(error, { context: { transaction_id: spans.transactionId } });
  }
});
```

## Session replay

Session replay records a timeline of each app session, shown on error groups
and incidents in Errorgap. On mobile it is **timeline only**: no screenshots
and no view snapshots.

| Event | Recorded when |
|---|---|
| `page_load` | The app starts ("App started"), or a new session starts after 30 minutes in the background ("App opened") |
| `navigation` | A screen is tracked, or the app returns from the background |
| `api_error` | A `fetch` call fails or answers 5xx |
| `error` | An error is reported, linked to its error group |
| `exit` | The app goes to the background |

Whether anything is recorded is set per project in **Settings → Session
replay**, not in code: nothing is recorded while replay is off, and a sampled
share of sessions while it is on.

Record screens with React Navigation:

```tsx
import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
import { Errorgap } from "@errorgap/react-native";

const ref = useNavigationContainerRef();
const onNavigation = Errorgap.errorgapNavigationListener(ref);

<NavigationContainer ref={ref} onReady={onNavigation} onStateChange={onNavigation}>
```

Or call `Errorgap.trackScreen("Checkout")` from your own navigator. Turn replay
off in one app with `Errorgap.init({ /* ... */, replay: false })`, and name the
app in the session list with `replay: { appName: "Acme" }`.

## Configuration reference

| Option | Default | Notes |
|---|---|---|
| `endpoint` | `""` | Base URL, no trailing slash. **Required** |
| `projectSlug` | — | **Required** |
| `projectId` | — | Optional, embedded in payload |
| `apiKey` | — | Sent as `x-errorgap-project-key` |
| `environment` | `production` | |
| `release` | — | App version/build for release tracking |
| `deviceInfo` | `{}` | Caller-supplied device metadata |
| `async` | `true` | Fire-and-forget delivery |
| `logger` | `console` | Pass `null` to silence |
| `filterKeys` | `["password", "token", "secret", ...]` | Substring match, case-insensitive |
| `captureGlobals` | `true` | Install global error hooks |
| `sourceMaps` | `true` | Resolve Metro bundle frames to original source |
| `apmEnabled` | `true` | Deliver APM transactions |
| `apmSampleRate` | `1` | Fraction (0..1) of transactions delivered |
| `logsEnabled` | `true` | Deliver structured logs |
| `minimumLogLevel` | `info` | Drop logs below this level |
| `maxBreadcrumbs` | `25` | Breadcrumbs retained per notice |

## Graceful flush

```ts
await Errorgap.flush();
```

## Development

```sh
npm install
npm test
npm run build
```

## License

MIT.
