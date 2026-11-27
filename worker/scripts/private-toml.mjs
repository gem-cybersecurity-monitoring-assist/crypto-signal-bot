import { parse } from 'smol-toml';

// Reject unsupported declarations even when TOML spells keys with quotes.
export function privateToml(text, forbidden) {
  try {
    const config = parse(text);
    if (forbidden.some(key => Object.hasOwn(config, key))) return null;
    return config;
  } catch { return null; }
}
