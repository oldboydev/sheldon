# First vault

Create your first Sheldon vault and confirm later commands can find it.

## Steps

1. Initialize a vault at an explicit path (recommended) or accept the default under `Documents/Sheldon`.
2. Create a topic so you have a place to ingest knowledge.
3. Optionally open the local web UI.

## Initialize

PowerShell:

```powershell
sheldon init C:\knowledge\sheldon
```

Unix:

```sh
sheldon init ~/knowledge/sheldon
```

`init` saves that path as the local default. Sheldon does **not** list vaults — use the saved default or pass `--vault`.

## Create a topic

PowerShell:

```powershell
sheldon topic create "Learning" --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon topic create "Learning" --vault ~/knowledge/sheldon
```

If you rely on the default from `init`, you can omit `--vault`.

## Open the web UI

```powershell
sheldon web
```

The UI listens on `http://127.0.0.1:<port>` and only accepts local connections.

## Next

- Command details: [init](init.html)
- Back to [Sheldon help](../index.html)
