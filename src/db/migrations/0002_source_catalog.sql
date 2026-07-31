INSERT OR IGNORE INTO sources (
  id, canonical_name, canonical_url, role, trust_prior, enabled,
  restrictions_json, last_success_at, health_status
) VALUES
  (
    'reuters', 'Reuters', 'https://www.reuters.com/', 'reporting', 0.95, 1,
    '{"bodyRetrieval":"forbidden","paywall":"licensed-or-metered","contentUse":"metadata-and-linked-excerpts","discoveryMechanism":"rss","sectionEligibility":["morning_brief","world","technology","ai_policy"],"feedUrl":"https://www.reutersagency.com/feed/","urlPolicy":{"allowedHosts":["www.reutersagency.com","www.reuters.com"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  ),
  (
    'associated-press', 'Associated Press', 'https://apnews.com/', 'reporting', 0.95, 1,
    '{"bodyRetrieval":"forbidden","paywall":"none","contentUse":"metadata-and-linked-excerpts","discoveryMechanism":"page","sectionEligibility":["morning_brief","world","technology","ai_policy"],"pageUrl":"https://apnews.com/hub/ap-top-news","urlPolicy":{"allowedHosts":["apnews.com"],"allowedPorts":[""],"allowedPathPrefixes":["/hub/ap-top-news","/article/"]},"listing":{"itemSelector":".PagePromo","linkSelector":"a.Link","titleSelector":".PagePromo-title","dateSelector":".Timestamp","dateAttribute":"data-date","summarySelector":".PagePromo-description","maxItems":50,"maxBodyFetches":0}}',
    NULL, 'unknown'
  ),
  (
    'npr', 'NPR', 'https://www.npr.org/', 'reporting', 0.9, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["morning_brief","world","technology","ai_policy"],"feedUrl":"https://feeds.npr.org/1001/rss.xml","urlPolicy":{"allowedHosts":["feeds.npr.org","www.npr.org"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  ),
  (
    'economist', 'The Economist', 'https://www.economist.com/', 'analysis', 0.85, 1,
    '{"bodyRetrieval":"forbidden","paywall":"hard","contentUse":"metadata-only","discoveryMechanism":"rss","sectionEligibility":["world","technology","ai_policy"],"feedUrl":"https://www.economist.com/the-world-this-week/rss.xml","urlPolicy":{"allowedHosts":["www.economist.com"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  ),
  (
    'nist', 'National Institute of Standards and Technology', 'https://www.nist.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"rss","sectionEligibility":["technology","ai_policy"],"feedUrl":"https://www.nist.gov/news-events/news/rss.xml","urlPolicy":{"allowedHosts":["www.nist.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  ),
  (
    'federal-register', 'Federal Register', 'https://www.federalregister.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"api","sectionEligibility":["morning_brief","ai_policy"],"apiUrl":"https://www.federalregister.gov/api/v1/documents.json","apiFormat":"federal-register-v1","urlPolicy":{"allowedHosts":["www.federalregister.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/api/v1/documents.json","/documents/"]}}',
    NULL, 'unknown'
  ),
  (
    'congress-gov', 'Congress.gov', 'https://www.congress.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"page","sectionEligibility":["morning_brief","ai_policy"],"pageUrl":"https://www.congress.gov/","urlPolicy":{"allowedHosts":["www.congress.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/"]},"listing":{"itemSelector":".basic-search-results-lists > li","linkSelector":".result-heading a","dateSelector":".result-date","summarySelector":".result-summary","maxItems":50,"maxBodyFetches":10}}',
    NULL, 'unknown'
  ),
  (
    'maryland-gov', 'Maryland.gov', 'https://www.maryland.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"page","sectionEligibility":["dmv","baltimore"],"pageUrl":"https://news.maryland.gov/","urlPolicy":{"allowedHosts":["news.maryland.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/"]},"listing":{"itemSelector":"article","linkSelector":"h2 a, h3 a","titleSelector":"h2, h3","dateSelector":"time","dateAttribute":"datetime","summarySelector":".entry-summary, .excerpt","maxItems":50,"maxBodyFetches":10}}',
    NULL, 'unknown'
  ),
  (
    'maryland-general-assembly', 'Maryland General Assembly', 'https://mgaleg.maryland.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"page","sectionEligibility":["ai_policy","dmv","baltimore"],"pageUrl":"https://mgaleg.maryland.gov/mgawebsite/Legislation/Tracking","urlPolicy":{"allowedHosts":["mgaleg.maryland.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/mgawebsite/"]},"listing":{"itemSelector":"table tbody tr","linkSelector":"a","dateSelector":"time, .date","dateAttribute":"datetime","summarySelector":"td:nth-child(3)","maxItems":50,"maxBodyFetches":10}}',
    NULL, 'unknown'
  ),
  (
    'dc-gov', 'DC.gov', 'https://dc.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"page","sectionEligibility":["dmv"],"pageUrl":"https://dc.gov/newsroom","urlPolicy":{"allowedHosts":["dc.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/newsroom","/release/"]},"listing":{"itemSelector":".usa-card, article","linkSelector":".usa-card__heading a, h2 a, h3 a","dateSelector":"time","dateAttribute":"datetime","summarySelector":".usa-card__description, .field--name-body","maxItems":50,"maxBodyFetches":10}}',
    NULL, 'unknown'
  ),
  (
    'dc-register', 'District of Columbia Register', 'https://dcregs.dc.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"page","sectionEligibility":["ai_policy","dmv"],"pageUrl":"https://dcregs.dc.gov/Common/DCR/Issues/IssueCategoryList.aspx?CategoryID=1","urlPolicy":{"allowedHosts":["dcregs.dc.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/Common/DCR/Issues/"]},"listing":{"itemSelector":"table tbody tr","linkSelector":"a","dateSelector":"time, .date, td:nth-child(2)","summarySelector":"td:nth-child(3)","maxItems":50,"maxBodyFetches":10}}',
    NULL, 'unknown'
  ),
  (
    'virginia-gov', 'Virginia.gov', 'https://www.virginia.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"page","sectionEligibility":["dmv"],"pageUrl":"https://www.virginia.gov/news/","urlPolicy":{"allowedHosts":["www.virginia.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/news/"]},"listing":{"itemSelector":"article, .news-item","linkSelector":"h2 a, h3 a","titleSelector":"h2, h3","dateSelector":"time, .date","dateAttribute":"datetime","summarySelector":".summary, .description","maxItems":50,"maxBodyFetches":10}}',
    NULL, 'unknown'
  ),
  (
    'virginia-lis', 'Virginia Legislative Information System', 'https://lis.virginia.gov/', 'primary', 0.98, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-government","discoveryMechanism":"page","sectionEligibility":["ai_policy","dmv"],"pageUrl":"https://lis.virginia.gov/","urlPolicy":{"allowedHosts":["lis.virginia.gov"],"allowedPorts":[""],"allowedPathPrefixes":["/"]},"listing":{"itemSelector":"table tbody tr, .result-item","linkSelector":"a","dateSelector":"time, .date","dateAttribute":"datetime","summarySelector":".summary, td:nth-child(3)","maxItems":50,"maxBodyFetches":10}}',
    NULL, 'unknown'
  ),
  (
    'wypr', 'WYPR', 'https://www.wypr.org/', 'reporting', 0.9, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["dmv","baltimore"],"feedUrl":"https://www.wypr.org/rss/local-news","urlPolicy":{"allowedHosts":["www.wypr.org"],"allowedPorts":[""],"allowedPathPrefixes":["/rss/","/wypr-news/"]}}',
    NULL, 'unknown'
  ),
  (
    'baltimore-banner', 'The Baltimore Banner', 'https://www.thebaltimorebanner.com/', 'reporting', 0.9, 1,
    '{"bodyRetrieval":"forbidden","paywall":"metered-or-hard","contentUse":"metadata-only","discoveryMechanism":"page","sectionEligibility":["dmv","baltimore"],"pageUrl":"https://www.thebaltimorebanner.com/community/local-news/","urlPolicy":{"allowedHosts":["www.thebaltimorebanner.com"],"allowedPorts":[""],"allowedPathPrefixes":["/community/local-news/"]},"listing":{"itemSelector":".tease-card, article","linkSelector":"a.tease-card__link, h2 a, h3 a","titleSelector":".tease-card__headline, h2, h3","dateSelector":"time","dateAttribute":"datetime","summarySelector":".tease-card__dek, .dek","maxItems":50,"maxBodyFetches":0}}',
    NULL, 'unknown'
  ),
  (
    'baltimore-brew', 'Baltimore Brew', 'https://www.baltimorebrew.com/', 'reporting', 0.88, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["baltimore"],"feedUrl":"https://www.baltimorebrew.com/feed/","urlPolicy":{"allowedHosts":["www.baltimorebrew.com"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  ),
  (
    'wtop', 'WTOP', 'https://wtop.com/', 'reporting', 0.88, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["dmv"],"feedUrl":"https://wtop.com/feed/","urlPolicy":{"allowedHosts":["wtop.com"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  ),
  (
    'maryland-matters', 'Maryland Matters', 'https://marylandmatters.org/', 'reporting', 0.9, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["ai_policy","dmv","baltimore"],"feedUrl":"https://marylandmatters.org/feed/","urlPolicy":{"allowedHosts":["marylandmatters.org"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  ),
  (
    'wamu', 'WAMU', 'https://wamu.org/', 'reporting', 0.9, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["dmv"],"feedUrl":"https://wamu.org/feed/","urlPolicy":{"allowedHosts":["wamu.org"],"allowedPorts":[""],"allowedPathPrefixes":["/"]}}',
    NULL, 'unknown'
  ),
  (
    'gdelt', 'GDELT', 'https://www.gdeltproject.org/', 'analysis', 0.5, 1,
    '{"bodyRetrieval":"forbidden","paywall":"none","contentUse":"discovery-metadata-only","discoveryMechanism":"api","sectionEligibility":["morning_brief","world","technology","ai_policy","dmv","baltimore"],"apiUrl":"https://api.gdeltproject.org/api/v2/doc/doc","discoveryOnly":true,"urlPolicy":{"allowedHosts":["api.gdeltproject.org"],"allowedPorts":[""],"allowedPathPrefixes":["/api/v2/doc/doc"]}}',
    NULL, 'unknown'
  ),
  (
    'monitoring-the-situation', 'Monitoring the Situation', 'https://www.mts.now/', 'analysis', 0.55, 1,
    '{"bodyRetrieval":"forbidden","paywall":"unknown","contentUse":"discovery-metadata-only","discoveryMechanism":"page","sectionEligibility":["world","technology"],"pageUrl":"https://www.mts.now/","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["www.mts.now"],"allowedPorts":[""],"allowedPathPrefixes":["/"]},"listing":{"itemSelector":"article","linkSelector":"h2 a, h3 a, a","titleSelector":"h2, h3","dateSelector":"time","dateAttribute":"datetime","summarySelector":"p","maxItems":50,"maxBodyFetches":0}}',
    NULL, 'unknown'
  ),
  (
    'polymarket', 'Polymarket', 'https://polymarket.com/', 'forecast', 0.5, 1,
    '{"bodyRetrieval":"forbidden","paywall":"none","contentUse":"forecast-metadata-only","discoveryMechanism":"api","sectionEligibility":["forecast"],"apiUrl":"https://gamma-api.polymarket.com/markets","canCorroborateFacts":false,"urlPolicy":{"allowedHosts":["gamma-api.polymarket.com"],"allowedPorts":[""],"allowedPathPrefixes":["/markets"]}}',
    NULL, 'unknown'
  ),
  (
    'arxiv', 'arXiv', 'https://arxiv.org/', 'primary', 0.85, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"open-research","discoveryMechanism":"api","sectionEligibility":["research","research_radar"],"apiUrl":"https://export.arxiv.org/api/query"}',
    NULL, 'unknown'
  ),
  (
    'semantic-scholar', 'Semantic Scholar', 'https://www.semanticscholar.org/', 'analysis', 0.75, 1,
    '{"bodyRetrieval":"forbidden","paywall":"none","contentUse":"research-metadata-only","discoveryMechanism":"api","sectionEligibility":["research","research_radar"],"apiUrl":"https://api.semanticscholar.org/graph/v1/"}',
    NULL, 'unknown'
  ),
  (
    'openalex', 'OpenAlex', 'https://openalex.org/', 'analysis', 0.75, 1,
    '{"bodyRetrieval":"forbidden","paywall":"none","contentUse":"research-metadata-only","discoveryMechanism":"api","sectionEligibility":["research","research_radar"],"apiUrl":"https://api.openalex.org/"}',
    NULL, 'unknown'
  ),
  (
    'stanford-research', 'Stanford Research', 'https://research.stanford.edu/', 'blog', 0.85, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar"],"pageUrl":"https://research.stanford.edu/news"}',
    NULL, 'unknown'
  ),
  (
    'berkeley-research', 'UC Berkeley Research', 'https://vcresearch.berkeley.edu/', 'blog', 0.85, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar"],"pageUrl":"https://vcresearch.berkeley.edu/news"}',
    NULL, 'unknown'
  ),
  (
    'harvard-research', 'Harvard Research', 'https://research.harvard.edu/', 'blog', 0.85, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar"],"pageUrl":"https://research.harvard.edu/"}',
    NULL, 'unknown'
  ),
  (
    'mit-research', 'MIT News Research', 'https://news.mit.edu/', 'blog', 0.88, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"rss","sectionEligibility":["research","research_radar"],"feedUrl":"https://news.mit.edu/rss/topic/artificial-intelligence2"}',
    NULL, 'unknown'
  ),
  (
    'cmu-research', 'Carnegie Mellon University Research', 'https://www.cmu.edu/research/', 'blog', 0.85, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar"],"pageUrl":"https://www.cmu.edu/news/stories/archives/research.html"}',
    NULL, 'unknown'
  ),
  (
    'penn-research', 'University of Pennsylvania Research', 'https://research.upenn.edu/', 'blog', 0.85, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar"],"pageUrl":"https://research.upenn.edu/news/"}',
    NULL, 'unknown'
  ),
  (
    'johns-hopkins-research', 'Johns Hopkins Research', 'https://research.jhu.edu/', 'blog', 0.88, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar","baltimore"],"pageUrl":"https://hub.jhu.edu/topics/research/"}',
    NULL, 'unknown'
  ),
  (
    'ut-austin-research', 'UT Austin Research', 'https://research.utexas.edu/', 'blog', 0.85, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar"],"pageUrl":"https://research.utexas.edu/news"}',
    NULL, 'unknown'
  ),
  (
    'georgia-tech-research', 'Georgia Tech Research', 'https://research.gatech.edu/', 'blog', 0.85, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar"],"pageUrl":"https://research.gatech.edu/news"}',
    NULL, 'unknown'
  ),
  (
    'google-research', 'Google Research', 'https://research.google/', 'blog', 0.9, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar","technology"],"pageUrl":"https://research.google/blog/"}',
    NULL, 'unknown'
  ),
  (
    'google-deepmind', 'Google DeepMind', 'https://deepmind.google/', 'blog', 0.9, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar","technology"],"pageUrl":"https://deepmind.google/discover/blog/"}',
    NULL, 'unknown'
  ),
  (
    'anthropic', 'Anthropic Research', 'https://www.anthropic.com/research', 'blog', 0.92, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar","technology","ai_policy"],"pageUrl":"https://www.anthropic.com/research"}',
    NULL, 'unknown'
  ),
  (
    'openai', 'OpenAI Research', 'https://openai.com/research/', 'blog', 0.92, 1,
    '{"bodyRetrieval":"permitted","paywall":"none","contentUse":"ephemeral-summarization","discoveryMechanism":"page","sectionEligibility":["research","research_radar","technology","ai_policy"],"pageUrl":"https://openai.com/research/"}',
    NULL, 'unknown'
  );
