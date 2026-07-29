UPDATE sources
SET
  canonical_url = 'https://www.mts.now/',
  restrictions_json = '{"bodyRetrieval":"forbidden","paywall":"unknown","contentUse":"discovery-metadata-only","discoveryMechanism":"page","sectionEligibility":["world","technology"],"pageUrl":"https://www.mts.now/","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["www.mts.now"],"allowedPorts":[""],"allowedPathPrefixes":["/"]},"listing":{"itemSelector":"article","linkSelector":"h2 a, h3 a, a","titleSelector":"h2, h3","dateSelector":"time","dateAttribute":"datetime","summarySelector":"p","maxItems":50,"maxBodyFetches":0}}'
WHERE
  id = 'monitoring-the-situation'
  AND canonical_name = 'Monitoring the Situation'
  AND canonical_url = 'https://mts.now/'
  AND role = 'analysis'
  AND trust_prior = 0.55
  AND enabled = 1
  AND restrictions_json IN (
    '{"bodyRetrieval":"forbidden","paywall":"unknown","contentUse":"discovery-metadata-only","discoveryMechanism":"manual","sectionEligibility":["world","technology"],"pageUrl":"https://mts.now/","canCorroborateFacts":false}',
    '{"bodyRetrieval":"forbidden","paywall":"unknown","contentUse":"discovery-metadata-only","discoveryMechanism":"page","sectionEligibility":["world","technology"],"pageUrl":"https://mts.now/","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["mts.now"],"allowedPorts":[""],"allowedPathPrefixes":["/"]},"listing":{"itemSelector":"article","linkSelector":"h2 a, h3 a, a","titleSelector":"h2, h3","dateSelector":"time","dateAttribute":"datetime","summarySelector":"p","maxItems":50,"maxBodyFetches":0}}'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM sources AS existing
    WHERE
      existing.canonical_url = 'https://www.mts.now/'
      AND existing.id <> 'monitoring-the-situation'
  );
