UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.preferredSection',
  'baltimore'
)
WHERE id IN (
  'wypr',
  'baltimore-banner',
  'baltimore-brew'
)
AND json_type(restrictions_json, '$.preferredSection') IS NULL;

UPDATE sources
SET restrictions_json = json_set(
  restrictions_json,
  '$.preferredSection',
  'dmv'
)
WHERE id IN (
  'maryland-gov',
  'maryland-general-assembly',
  'dc-gov',
  'dc-register',
  'virginia-gov',
  'virginia-lis',
  'wtop',
  'maryland-matters',
  'wamu'
)
AND json_type(restrictions_json, '$.preferredSection') IS NULL;
