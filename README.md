# @errorgap/react-native

React Native notifier for [Errorgap](https://errorgap.com). Captures uncaught
JS errors and unhandled promise rejections (V8 and Hermes stack formats) and
ships notices to an Errorgap server. JS-side errors only in v1 — pair with
`errorgap-swift` / `errorgap-android` for native crashes.

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

## Configuration reference

| Option | Default | Notes |
|---|---|---|
| `endpoint` | `http://127.0.0.1:3030` | Base URL, no trailing slash |
| `projectSlug` | — | **Required** |
| `projectId` | — | Optional, embedded in payload |
| `apiKey` | — | Sent as `x-errorgap-project-key` |
| `environment` | `development` | |
| `release` | — | App version/build for release tracking |
| `deviceInfo` | `{}` | Caller-supplied device metadata |
| `async` | `true` | Fire-and-forget delivery |
| `logger` | `console` | Pass `null` to silence |
| `filterKeys` | `["password", "token", "secret", ...]` | Substring match, case-insensitive |
| `captureGlobals` | `true` | Install global error hooks |

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
