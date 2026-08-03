UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrl',
  'https://www.wypr.org/wypr-news.rss',
  '$.urlPolicy',
  json('{"allowedHosts":["www.wypr.org"],"allowedPorts":[""],"allowedPathPrefixes":["/wypr-news.rss","/wypr-news/"]}')
)
WHERE id = 'wypr'
AND json_extract(restrictions_json, '$.feedUrl') =
  'https://www.wypr.org/rss/local-news';

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.feedUrl',
  'https://content.baltimorebrew.com/rss',
  '$.urlPolicy',
  json('{"allowedHosts":["content.baltimorebrew.com","www.baltimorebrew.com"],"allowedPorts":[""],"allowedPathPrefixes":["/rss","/feed/","/"]}')
)
WHERE id = 'baltimore-brew'
AND json_extract(restrictions_json, '$.feedUrl') =
  'https://www.baltimorebrew.com/feed/';
