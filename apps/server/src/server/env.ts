/**
 * Reads a SynCode environment variable, honouring the `NEXUS_` name it used to
 * have.
 *
 * The rename made every one of these a deployment hazard. `NEXUS_DATA_DIR` is
 * set in `fly.toml` and points at the mounted volume; a server that stops
 * reading it falls back to a relative `./data` inside the container, comes up
 * clean, serves happily, and writes the append-only event log — the
 * authoritative store (I3) — to a directory that vanishes on the next restart.
 * Nothing errors. The symptom is a room that has forgotten everything, hours
 * later, and by then the deploy looks unrelated.
 *
 * So both names work and the new one wins. The cost is one function; the
 * alternative was a rename that had to land in the same instant as a config
 * change on a machine I do not control, with silent data loss if the two ever
 * drifted apart. Deleting the fallback is safe only once nothing in fly.toml,
 * no Dockerfile, and no operator's shell profile still says NEXUS_.
 */
export function readEnv(suffix: string): string | undefined {
  return process.env[`SYNCODE_${suffix}`] ?? process.env[`NEXUS_${suffix}`];
}
