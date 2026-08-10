UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy', json(json_extract(restrictions_json, '$.urlPolicy')),
  '$.articleUrlPolicy', json(json_extract(restrictions_json, '$.urlPolicy'))
)
WHERE json_type(restrictions_json, '$.urlPolicy') = 'object'
  AND json_type(restrictions_json, '$.feedUrlPolicy') IS NULL
  AND json_type(restrictions_json, '$.articleUrlPolicy') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy',
    json('{"allowedHosts":["www.alignmentforum.org"],"allowedPorts":[""],"allowedPathPrefixes":["/feed.xml"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["www.alignmentforum.org","www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/posts/"]}')
)
WHERE id = 'alignment-forum'
  AND json_extract(
    restrictions_json,
    '$.feedUrlPolicy.allowedHosts[0]'
  ) = 'www.alignmentforum.org';

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy',
    json('{"allowedHosts":["www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/feed.xml"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["www.lesswrong.com"],"allowedPorts":[""],"allowedPathPrefixes":["/posts/"]}')
)
WHERE id = 'lesswrong-curated'
  AND json_extract(
    restrictions_json,
    '$.feedUrlPolicy.allowedHosts[0]'
  ) = 'www.lesswrong.com';

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrlPolicy',
    json('{"allowedHosts":["news.mit.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/rss/"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["news.mit.edu"],"allowedPorts":[""],"allowedPathPrefixes":["/202"]}')
)
WHERE id = 'mit-research'
  AND json_extract(
    restrictions_json,
    '$.feedUrlPolicy.allowedHosts[0]'
  ) = 'news.mit.edu';

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.pageUrl', 'https://openai.com/research/index/publication/',
  '$.feedUrlPolicy',
    json('{"allowedHosts":["openai.com"],"allowedPorts":[""],"allowedPathPrefixes":["/research/index/publication/"]}'),
  '$.articleUrlPolicy',
    json('{"allowedHosts":["openai.com"],"allowedPorts":[""],"allowedPathPrefixes":["/index/","/research/"]}')
)
WHERE id = 'openai'
  AND json_extract(
    restrictions_json,
    '$.feedUrlPolicy.allowedHosts[0]'
  ) = 'openai.com';
