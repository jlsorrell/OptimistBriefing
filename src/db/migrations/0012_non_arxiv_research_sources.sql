INSERT OR IGNORE INTO sources (
  id, canonical_name, canonical_url, role, trust_prior, enabled,
  restrictions_json, last_success_at, health_status
) VALUES (
  'lesswrong-frontpage',
  'LessWrong Frontpage',
  'https://www.lesswrong.com/feed.xml?view=frontpage&karmaThreshold=20',
  'blog',
  0.8,
  1,
  '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["research","research_radar"],"feedUrl":"https://www.lesswrong.com/feed.xml?view=frontpage&karmaThreshold=20","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/feed.xml","/posts/"]},"feedUrlPolicy":{"allowedHosts":["www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/feed.xml"]},"articleUrlPolicy":{"allowedHosts":["www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/posts/"]}}',
  NULL,
  'unknown'
);

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.pageUrl', 'https://paperswithcode.co/papers/recent'
)
WHERE id = 'papers-with-code-co'
  AND json_extract(restrictions_json, '$.discoveryMechanism') = 'page'
  AND json_extract(restrictions_json, '$.pageUrl') =
    'https://paperswithcode.co/?order_by=date_published'
  AND (
    (
      json_type(restrictions_json, '$.feedUrlPolicy') IS NULL
      AND json_type(restrictions_json, '$.articleUrlPolicy') IS NULL
    )
    OR (
      json_extract(restrictions_json, '$.feedUrlPolicy') =
        json('{"allowedHosts":["paperswithcode.co"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}')
      AND json_extract(restrictions_json, '$.articleUrlPolicy') =
        json('{"allowedHosts":["paperswithcode.co"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}')
    )
  );

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.pageUrl', 'https://deepmind.google/blog/',
  '$.feedUrlPolicy',
    json('{"allowedHosts":["deepmind.google"],"allowedPorts":[""],"allowedPathPrefixes":["/blog/"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["deepmind.google"],"allowedPorts":[""],"allowedPathPrefixes":["/blog/"]}')
)
WHERE id = 'google-deepmind'
  AND json_extract(restrictions_json, '$.discoveryMechanism') = 'page'
  AND json_extract(restrictions_json, '$.pageUrl') =
    'https://deepmind.google/discover/blog/'
  AND (
    (
      json_type(restrictions_json, '$.feedUrlPolicy') IS NULL
      AND json_type(restrictions_json, '$.articleUrlPolicy') IS NULL
    )
    OR (
      json_extract(restrictions_json, '$.feedUrlPolicy') =
        json('{"allowedHosts":["deepmind.google"],"allowedPorts":[""],"allowedPathPrefixes":["/discover/blog/"]}')
      AND json_extract(restrictions_json, '$.articleUrlPolicy') =
        json('{"allowedHosts":["deepmind.google"],"allowedPorts":[""],"allowedPathPrefixes":["/discover/blog/"]}')
    )
  );

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.articleUrlPolicy',
    json('{"allowedHosts":["www.anthropic.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research/"]}')
)
WHERE id = 'anthropic'
  AND json_extract(restrictions_json, '$.discoveryMechanism') = 'page'
  AND json_extract(restrictions_json, '$.pageUrl') =
    'https://www.anthropic.com/research'
  AND json_extract(restrictions_json, '$.feedUrlPolicy') =
    json('{"allowedHosts":["www.anthropic.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research"]}')
  AND json_extract(restrictions_json, '$.articleUrlPolicy') =
    json('{"allowedHosts":["www.anthropic.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research"]}');

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy',
    json('{"allowedHosts":["www.anthropic.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["www.anthropic.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research/"]}')
)
WHERE id = 'anthropic'
  AND json_extract(restrictions_json, '$.discoveryMechanism') = 'page'
  AND json_extract(restrictions_json, '$.pageUrl') =
    'https://www.anthropic.com/research'
  AND json_type(restrictions_json, '$.feedUrlPolicy') IS NULL
  AND json_type(restrictions_json, '$.articleUrlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy',
    json('{"allowedHosts":["research.google"],"allowedPorts":[""],"allowedPathPrefixes":["/blog/"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["research.google"],"allowedPorts":[""],"allowedPathPrefixes":["/blog/"]}')
)
WHERE id = 'google-research'
  AND json_extract(restrictions_json, '$.discoveryMechanism') = 'page'
  AND json_extract(restrictions_json, '$.pageUrl') =
    'https://research.google/blog/'
  AND json_type(restrictions_json, '$.feedUrlPolicy') IS NULL
  AND json_type(restrictions_json, '$.articleUrlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  json_remove(restrictions_json, '$.pageUrl'),
  '$.discoveryMechanism', 'rss',
  '$.feedUrl', 'https://openai.com/news/rss.xml',
  '$.feedUrlPolicy',
    json('{"allowedHosts":["openai.com"],"allowedPorts":[""],"allowedPathPrefixes":["/news/rss.xml"]}')
)
WHERE id = 'openai'
  AND json_extract(restrictions_json, '$.discoveryMechanism') = 'page'
  AND json_extract(restrictions_json, '$.pageUrl') =
    'https://openai.com/research/index/publication/'
  AND json_type(restrictions_json, '$.feedUrl') IS NULL
  AND json_extract(restrictions_json, '$.feedUrlPolicy') =
    json('{"allowedHosts":["openai.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research/index/publication/"]}')
  AND json_extract(restrictions_json, '$.articleUrlPolicy') =
    json('{"allowedHosts":["openai.com"],"allowedPorts":[""],"allowedPathPrefixes":["/index/","/research/"]}');
