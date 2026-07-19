-- Drop Jina entirely: Jina Reader (page fetching fallback for JS-rendered
-- pages) is removed outright — direct fetch only. Jina Search (company
-- research) is replaced by Tavily, so the settings column is repurposed.

alter table public.settings rename column jina_api_key to tavily_api_key;

alter table public.watched_pages drop column fetch_source;
