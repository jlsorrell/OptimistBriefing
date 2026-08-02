# Compact Cluster Checkpoints

## Context

The first live preview run collected and normalized candidates successfully. A transient OpenAI connection failure cleared on replay, after which enrichment, assessment, and scoring completed. The cluster checkpoint then failed with `SQLITE_TOOBIG`.

The scored checkpoint contains 32 news items and is 1,108,247 characters. Its 1,536-dimensional embeddings account for 942,286 characters. `clusterNews` receives those items and places them in each development's `items` and `representativeItem` fields; `itemFromDevelopment` also retains the representative item's workflow payload. This duplicates transient vectors and pushes the single serialized D1 checkpoint value beyond the platform limit.

## Decision

Embeddings are transient pipeline data. The cluster stage will build its similarity lookup from the enriched items, remove embeddings from the items passed into `clusterNews`, and remove them from research items returned alongside clustered news. The resulting developments therefore retain their evidence and provenance but contain no vectors in `items`, `representativeItem`, or the outer workflow item.

This is preferred to reducing embedding dimensions, which changes ranking behavior, and to chunking checkpoint storage, which adds a larger persistence protocol. No downstream stage reads embeddings after clustering.

## Data Flow

1. Enrichment obtains embeddings and stores them in workflow-only metadata so scoring and restart checkpoints remain deterministic.
2. Clustering extracts the news vectors into an in-memory lookup.
3. Clustering removes `metadata.workflow.embedding` from copies of all news and research items.
4. `clusterNews` uses the lookup for semantic similarity while constructing developments from the compact news copies.
5. The cluster checkpoint stores compact research items and development items. All other workflow metadata, source evidence, scores, and durable item fields remain unchanged.

Earlier checkpoints intentionally retain vectors so a retry beginning before clustering can resume without paying for another embedding call. Checkpoints at and after clustering do not retain them.

## Error Handling and Compatibility

The compaction helper will preserve items that have no workflow payload or no embedding. It will parse the result through the existing item schema, so malformed payloads still fail through the current pipeline error path. Cluster identity, representative selection, semantic thresholds, and downstream schemas remain unchanged.

## Verification

A regression test will construct news items with production-sized embeddings, verify that semantic clustering still combines related items, and verify that neither the outer clustered item nor its nested development contains an embedding. Existing workflow and editorial suites will run unchanged.

After deployment to the preview Worker, today's retryable canary will be replayed. Success requires the cluster checkpoint to persist, the workflow to publish or intentionally produce a partial edition, the preview site to serve that edition, and recorded model cost to remain below the configured $5 monthly cap.
