INSERT OR IGNORE INTO sources (
  id, canonical_name, canonical_url, role, trust_prior, enabled,
  restrictions_json, last_success_at, health_status
) VALUES
  (
    'alignment-forum', 'Alignment Forum', 'https://www.alignmentforum.org/', 'blog', 0.8, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["research","research_radar"],"feedUrl":"https://www.alignmentforum.org/feed.xml?view=frontpage","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["www.alignmentforum.org"],"allowedPorts":[""],"allowedPathPrefixes":["/feed.xml","/posts/"]}}',
    NULL, 'unknown'
  ),
  (
    'lesswrong-curated', 'LessWrong Curated', 'https://www.lesswrong.com/', 'blog', 0.8, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["research","research_radar"],"feedUrl":"https://www.lesswrong.com/feed.xml?view=curated","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/feed.xml","/posts/"]}}',
    NULL, 'unknown'
  ),
  (
    'papers-with-code-co', 'Papers with Code', 'https://paperswithcode.co/', 'analysis', 0.75, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"discovery-metadata-only","discoveryMechanism":"page","sectionEligibility":["research","research_radar"],"pageUrl":"https://paperswithcode.co/?order_by=date_published","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["paperswithcode.co"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  );

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["research.stanford.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/news"]}')
)
WHERE id = 'stanford-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["vcresearch.berkeley.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/news"]}')
)
WHERE id = 'berkeley-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["research.harvard.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}')
)
WHERE id = 'harvard-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["news.mit.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/rss/"]}')
)
WHERE id = 'mit-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["www.cmu.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/news/"]}')
)
WHERE id = 'cmu-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["research.upenn.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/news/"]}')
)
WHERE id = 'penn-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["hub.jhu.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/topics/research/"]}')
)
WHERE id = 'johns-hopkins-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["research.utexas.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/news"]}')
)
WHERE id = 'ut-austin-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["research.gatech.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/news"]}')
)
WHERE id = 'georgia-tech-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["research.google"],"allowedPorts":[""],"allowedPathPrefixes":["/blog/"]}')
)
WHERE id = 'google-research'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["deepmind.google"],"allowedPorts":[""],"allowedPathPrefixes":["/discover/blog/"]}')
)
WHERE id = 'google-deepmind'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["www.anthropic.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research"]}')
)
WHERE id = 'anthropic'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.urlPolicy',
  json('{"allowedHosts":["openai.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research/"]}')
)
WHERE id = 'openai'
  AND json_type(restrictions_json, '$.urlPolicy') IS NULL;
