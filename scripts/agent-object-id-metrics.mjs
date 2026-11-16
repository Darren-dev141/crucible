// The object ID pass lists the part behind each ID in the job metrics; longer lists are cut and flagged.
const MAXIMUM_OBJECT_NAMES = 1000;

// The part behind each object ID, and the IDs of each node (a prop made of several parts is one node), cut at the limit.
export function objectIdMetrics(passInfo) {
  const nodeEntries = Object.entries(passInfo.objectNodes ?? {});
  return {
    objectNames: passInfo.objectNames.slice(0, MAXIMUM_OBJECT_NAMES),
    objectNamesTruncated: passInfo.objectNames.length > MAXIMUM_OBJECT_NAMES,
    objectNodes: Object.fromEntries(nodeEntries.slice(0, MAXIMUM_OBJECT_NAMES)),
    objectNodesTruncated: nodeEntries.length > MAXIMUM_OBJECT_NAMES,
  };
}
