# pi-gonka

[Gonka.gg](https://gonka.gg) proxy provider for [pi.dev](https://pi.dev).

## Features

- Registers `gonka` as a pi provider.
- Reads the API key from `~/.pi/agent/auth.json`.
- Fetches the live model list from `https://proxy.gonka.gg/v1/models`.
- Fetches live USD pricing from `https://proxy.gonka.gg/api/pricing`.
- Fetches capabilities from `https://proxy.gonka.gg/api/models/capabilities`.
- Caches everything in `~/.pi/agent/gonka-cache.json` for 24 hours.
- Updates automatically on startup when the cache is stale.
- Provides `/gonka-refresh` to force an immediate refresh.

## Install

### From npm

```bash
pi install npm:pi-gonka
```

### From a local path

```bash
cd /path/to/pi-gonka
pi install -l .
```

Or install globally:

```bash
pi install /path/to/pi-gonka
```

Or copy `extensions/gonka.ts` to `~/.pi/agent/extensions/gonka.ts`.

## Authentication

Add your key to `~/.pi/agent/auth.json`:

```json
{
  "gonka": {
    "type": "api_key",
    "key": "sk-your-gonka-api-key"
  }
}
```

Get a key at [proxy.gonka.gg/dashboard/keys](https://proxy.gonka.gg/dashboard/keys).

## Usage

Select a Gonka model:

```bash
pi --provider gonka --model gonka/Qwen/Qwen3-235B-A22B-Instruct-2507-FP8
```

Or use the interactive model picker (`/model` or `Ctrl+L`).

Force refresh models and pricing:

```bash
/gonka-refresh
```

## Cache

The extension stores cached data in:

```
~/.pi/agent/gonka-cache.json
```

It refreshes automatically when any entry is older than 24 hours. Use `/gonka-refresh` to refresh immediately.

## License

MIT
