export function suitesForTarget(suites, resolvedVersion) {
  const normalized = JSON.parse(JSON.stringify(suites));
  const vector = normalized
    .flatMap((suite) => suite.vectors ?? [])
    .find((candidate) => candidate.id === "package.metadata.published-surface");

  if (!vector?.expect?.package?.metadataSubset) {
    throw new Error("Package metadata vector is missing its expected metadata subset");
  }

  const previous = vector.expect.package.metadataSubset.version;
  vector.expect.package.metadataSubset.version = resolvedVersion;
  return {
    suites: normalized,
    normalizations: [{
      id: "package-metadata-version",
      vectorId: vector.id,
      field: "expect.package.metadataSubset.version",
      previous,
      value: resolvedVersion,
      reason: "Target identity is recorded separately and is not a behavioral regression."
    }]
  };
}
