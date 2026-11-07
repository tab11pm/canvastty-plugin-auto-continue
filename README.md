# Auto Continue for CanvasTTY

When an AI coding agent in a CanvasTTY card stops at its usage limit, this plugin continues it in the same card once the limit resets, using only CanvasTTY itself:

1. a working → idle change of an agent card (Claude Code or Codex) whose screen ends in the provider's limit banner (or Claude's usage-limit menu) is a stop; with guards against "not your usage limit" and per-model limits, which have no reset to wait for;
2. the reset time is the exhausted window (100 %) of that provider in CanvasTTY's own limits (`limits.get`, the snapshot HOME shows), the later one when both the 5-hour and the weekly window are full; the card gets a `⏸ until 03:00` badge;
3. after the reset it dismisses Claude's limit menu if it is still on screen, types the continue message (`resumeMessage` in the settings below) and checks that a new turn started; when the limit is still there it looks the reset up again and retries, up to 5 times. A turn started by hand before the reset cancels it.

The limit banner patterns are adapted from [unsnooze](https://github.com/saaranshM/unsnooze) (MIT); unsnooze itself is not needed.

## Requirements

CanvasTTY built from branch `feat/plugin-session-control-any`: plugin permission `sessions:control-any`, `sessions.dismiss`, and `limits.get` for services. Stock CanvasTTY lets a plugin type only into cards it started itself, and gives limits only to web surfaces.

## Install

With CanvasTTY closed:

```sh
scripts/sideload.sh
```

Then start CanvasTTY and trust **Auto Continue** under **Settings → Agents → Extension native code**.

An agent started by hand in a plain terminal card is not resumed: CanvasTTY lets plugins type only into agent cards. Start agents as agent cards.

## Settings

Optional `~/.config/canvastty/plugin-data/dev.tab11pm.auto-continue/settings.json`: `resumeMessage` (default: "The usage limit has reset. Continue the task from where you stopped and finish it."), `graceMs` (wait after the reset, 20 s), `tickMs`, `lookupRetryMs`, `lookupSlowMs`, `maxLookups` (lookups without a full limit window before the stop is dropped as a false one, 8), `verifyMs`, `retryMs`, `maxAttempts`.

Test mode, to see a resume land without a real limit: `{"testCardTitle": "auto continue test", "testResetInMs": 60000}`, then restart the service and open a Claude card titled `auto continue test`. About a minute later the resume message is typed into it (once per card until the service restarts). Remove the keys afterwards.

## Test

```sh
node --test test/
```
