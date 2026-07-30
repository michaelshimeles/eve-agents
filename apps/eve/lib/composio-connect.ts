import { unstable_cache } from "next/cache";

// Minimal MCP client for Composio Connect's management surface. The agent
// talks to connect.composio.dev/mcp through eve's connection layer; the web
// UI's Connections panel needs the same COMPOSIO_MANAGE_CONNECTIONS tool
// (list / add / remove) without spinning up a whole agent session, so this
// speaks the MCP HTTP protocol directly with the consumer API key.

const MCP_URL = "https://connect.composio.dev/mcp";
const TOOLKIT_CATALOG_URL = "https://docs.composio.dev/data/toolkits.json";

export interface ComposioToolkit {
  slug: string;
  name: string;
}

// The consumer key accepted by Composio Connect is intentionally not a
// Composio project API key, so it cannot call the authenticated REST catalog.
// Keep a full slug snapshot for cold starts during a public-catalog outage.
// The normal path below still refreshes names and newly added toolkits daily.
const FALLBACK_TOOLKIT_SLUGS = `
_1password _21risk _2chat ably abstract abuselpdb abyssale accredible_certificates acculynx active_campaign active_trail addressfinder addresszen adrapid adyntel aeroleads affinda affinity agencyzoom agent_mail agentql agenty agiled agility_cms ahrefs ai_ml_api airtable aivoov alchemy algodocs algolia all_images_ai alpaca alpha_vantage altoviz alttext_ai amara ambee ambient_weather amcards amplitude anchor_browser anonyflow anthropic_administrator apaleo api2pdf api_bible api_labz api_ninjas api_sports apiflash apify apify_mcp apilio apipie_ai apiverve apollo appcircle appdrag appointo appveyor artificial_analysis aryn asana ascora ashby asin_data_api astica_ai async_interview attio autobound autom ayrshare backendless bamboohr bannerbear bart basecamp baselinker baserow basin beaconchain beaconstac beamer beeminder bench benchmark_email benzinga bestbuy better_proposals better_stack bettercontact bidsketch big_data_cloud bigmailer bigml bigpicture_io bitbucket bitquery bitwarden blackbaud blackboard blazemeter blocknative boldsign bolna boloforms bolt_iot bonsai bookingmood booqable borneo botbaba botpress botsonic botstar bouncer box boxhero brandfetch breathehr breeze breezy_hr brevo brex brightdata brilliant_directories browseai browser_tool browserbase_tool browserless btcpay_server bubble bugbug bugherd bugsnag buildkite builtwith bunnycdn byteforms
cabinpanda cal calendarhero calendly callerapi callingly callpage campaign_cleaner campayn canny canva canvas capsule_crm carbone cardly castingwords cats cdr_platform celigo census_bureau centralstationcrm certifier chaser chatbotkit chatfai chatwork chmeetings cincopa circleci claid_ai classmarker clearout clickhouse clickmeeting clicksend clickup clientary clockify close cloudcart cloudconvert cloudflare cloudflare_api_key cloudflare_browser_rendering cloudinary cloudlayer cloudpress coassemble coda codacy codeinterpreter codemagic codereadr cody coinbase coinmarketcal coinmarketcap coinranking college_football_data commcare companyenrich composio composio_search confluence connecteam constant_contact contentful contentful_graphql context7_mcp control_d conversion_tools convertapi convex conveyor convolo_ai corrently countdown_api coupa craftmypdf crowdin crowterminal crustdata cults curated currencyscoop currents_api cursor customerio customgpt customjs cutt_ly d2lbrightspace dadata_ru daffy dailybot dart data247 databox databricks datadog dataforseo datagma datarobot datascope daytona deadline_funnel deepgram deepimage deepseek deepwiki_mcp delighted demio deployhq desktime detrack devin_mcp devto dialmycalls dialpad dictionary_api diffbot digicert digital_ocean discord discordbot dnsfilter dock_certs docker_hub docmosis docnify docparser docraptor docsautomator docsbot_ai docsumo docugenerate documenso documint docupilot docupost docuseal docusign doppler doppler_marketing_automation doppler_secretops dotsimple dovetail dpd2 draftable dreamstudio dripcel dromo dropbox dropbox_sign dropcontact dub dungeon_fighter_online dynamics365 dynapictures
e2b eagle_doc echtpost ecologi egnyte elasticsearch elevenlabs elevenreader elorus emailable emaillistverify emailoctopus emelia encodian endorsal engage enginemailer enigma entelligence eodhd_apis epic_games erpnext esignatures_io espocrm esputnik etermin evenium eventbrite eventee eventzilla everhour eversign exa excel exist expofp extracta_ai facebook faceup fal_ai faraday fathom feathery felt fibery fidel_api figma files_com fillout_forms finage findymail finerworks fingertip finmei fireberry firecrawl fireflies firmao fixer fixer_io flexisign flowiseai flutterwave fluxguard fly folk follow_up_boss fomo forcemanager formbricks formcarry formdesk formsite foursquare fraudlabs_pro freeagent freshbooks freshdesk freshservice fullenrich gagelist gamma gan_ai gatherup gemini gender_api genderapi_io genderize geoapify geocodio geokeo getform getprospect gift_up gigasheet giphy gist gitea github gitlab givebutter gladia gleap globalping gmail godial gong goodbits goody google_address_validation google_admin google_analytics google_chat google_classroom google_cloud_vision google_maps google_search_console googleads googlebigquery googlecalendar googlecontacts googledocs googledrive googleforms googlemeet googlephotos googlesheets googleslides googlesuper googletasks gorgias gosquared grafana grafbase granola_mcp graphhopper greenhouse griptape grist groqcloud gtmetrix gumroad gusto habitica hackernews hackerrank_work handwrytten happy_scribe harvest hashnode headout heartbeat helloleads help_scout helpdesk helpwise here hex heygen heyreach heyy heyzine highergov highlevel honeybadger honeycomb_mcp honeyhive hookdeck hostinger hotspotsystem html_to_image hub_planner hubspot hugging_face humanitix humanloop hunter hypeauditor hyperbrowser hyperise hystruct
ibm_x_force_exchange icypeas identitycheck ignisign imagekit_io imagior imejis_io imgbb imgix incident_io influxdb_cloud insighto_ai instacart instagram instantly intelliprint intercom interzoid ip2location ip2location_io ip2proxy ip2whois ipdata_co ipinfo_io iqair_airvisual iterable jigsawstack jira jobnimbus jotform jumpcloud junglescout kadoa kaggle kaleido kanbanize keen_io keyword kibana kickbox kieai kit klaviyo klazify klipfolio knack ko_fi kommo kontent_ai kraken_io l2s labs64_netlicensing lagrowthmachine landbot langbase laposta launch_darkly leadboxer leadfeeder leadiq leadoku leexi leiga lemlist lemon_squeezy lessonspace lever leverly lexoffice linear linguapop linkedin linkedin_ads linkhut linkly linkup listclean listennotes livesession llmwhisperer lmnt lob lodgify logo_dev loomio loops_so loyverse lusha magnetic mailbluster mailboxlayer mailcheck mailchimp mailcoach mailercloud mailerlite mailersend mails_so mailsoftly mailtrap maintainx make manus mapbox mapulus marketstack matterport maxio melo mem mem0 memberspot memberstack membervault mercury_mcp metaads metabase metaphor metatextai mezmo microsoft_clarity microsoft_power_bi microsoft_teams microsoft_todo minerstat mintlify miro missive mistral_ai mixmax mixpanel mobbin_mcp mocean moco modelry monday monday_mcp moneybird moonclerk moosend mopinion more_trees motion moz msg91 mural mx_technologies mx_toolbox nango nano_nets nasa nasdaq needle neo4j neon nethunt_crm netsuite neuronwriter neutrino neverbounce new_relic news_api nextdns ngrok niftyimages ninox nocodb nocrm_io northflank notion nozbe_teams npm ntfy nusii_proposals nutshell
ocr_web_service ocrspace odoo oksign ollama omnisend one_drive onedesk onenote onepage onesignal_rest_api onesignal_user_auth open_sea openai opencage opengraph_io openperplex openrouter openweather_api optimoroute outline outlook owl_protocol page_x pagerduty pandadoc paperform paradym parallel parma parsehub parsera parseur parsio_io passcreator passslot payhere payhip paypal paystack pdf4me pdf_api_io pdf_co pdfless pdfmonkey penpot peopledatalabs perigon perplexityai persistiq persona pexels phantombuster piggy piloterr pilvio pinecone pingdom pipedrive pipeline_crm placekey placid plain planly planyo_online_booking plasmic platerecognizer plausible_analytics plisio pointagram polygon polygon_io polymarket polymarket_us poof postalytics postgrid postgrid_verify posthog postiz_mcp postman postmark prerender printautopilot prisma prismic proabono process_street procfu productboard productlane project_bubble promptmate_io proofly proxiedmail push_by_techulus pushbullet pushover pylon_mcp quaderno quickbooks radar rafflys ragic ragie railway raisely ramp rawg_video_games_database razorpay re_amaze realphonevalidation recallai recruitee redcircle_api reddit reddit_ads referralrock refiner remarkety remote_retrieval remove_bg render renderform rentman repairshopr replicate reply reply_io resend respond_io retailed retellai retently rev rev_ai revolt ritekit rize rkvst roam roboflow rocket_reach rocketadmin rocketlane rollbar rootly rosette_text_analytics route4me rudderstack_transformation runpod safetyculture salesflare salesforce salesforce_service_cloud salesmate sanity sap_successfactors saperly satismeter saucelabs scale_ai scheduleonce scrape_do scrapegraph_ai scrapfly scrapingant scrapingbee screenshot_fyi screenshotone search_api seat_geek securitytrails segment segmetrics semanticscholar semrush sendbird sendbird_ai_chabot sender sendfox sendgrid sendlane sendloop sendspark sensibo sentry seqera serpapi serpdog serphouse serply serveravatar servicem8 servicenow sevdesk share_point sharepoint_graph shipday shipengine shippo shopify short_io short_menu shortcut shorten_rest shortpixel shotstack sidetracker signaturely signpath signwell similarweb_digitalrank_api simla_com simple_analytics simplekpi simplero simplesat sitespeakai skyfire slack slackbot slite smartproxy sms_alert smtp2go smugmug snapchat snowflake snowflake_basic softr solcast soundcloud sourcegraph specific splitwise spoki spondyr spotify spotlightr square sslmate_cert_spotter_api stack_ai stack_exchange stannp starton statuscake storeganise storerocket stormboard stormglass_io storyblok strava streamtime stripe studio_by_ai21_labs suitedash supabase supadata superchat supersaas supportbee supportivekoala survey_monkey svix swaggerhub swarmsyncai sympla synthflow_ai
taggun talenthr tally tapfiliate tave tavily tavily_mcp taxjar teamcamp telegram telnyx teltel templated test_app text_to_pdf textcortex textit textrazor thanks_io the_odds_api ticketmaster ticktick tidy tiktok timecamp timelinesai timelink timely tinyfish_mcp tinypng tinyurl tisane tldv todoist toggl token_metrics tomba tomtom toneden tpscheck trello triggercmd tripadvisor tripadvisor_content_api truvera turbot_pipes turso twelve_data twitter twocaptcha typeform typefully typless u301 unione unisender uniswap_api updown_io uploadcare uptimerobot userflow userlist v0 vapi vectorshift veo vercel verifiedemail veriphone vestaboard virustotal waboxapp wachete waiverfile wakatime wati weathermap webex webflow webscraper_io webscraping_ai webvizio whatsapp whautomate whoisfreaks whop winston_ai wisepops wit_ai wix wix_mcp wiza wolfram_alpha_api woodpecker_co workable workday workiom worksnaps world_news_api wrike writer xata xero y_gy yandex yelp ynab yousearch youtube zendesk zenrows zenserp zep zeplin zerobounce zixflow zoho zoho_bigin zoho_books zoho_desk zoho_inventory zoho_invoice zoho_mail zoom zoominfo zulip zylvie zyte_api
`
  .trim()
  .split(/\s+/);

const FALLBACK_TOOLKIT_NAMES: Readonly<Record<string, string>> = {
  airtable: "Airtable",
  asana: "Asana",
  discord: "Discord",
  dropbox: "Dropbox",
  figma: "Figma",
  github: "GitHub",
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledocs: "Google Docs",
  googledrive: "Google Drive",
  googlesheets: "Google Sheets",
  hubspot: "HubSpot",
  jira: "Jira",
  linear: "Linear",
  notion: "Notion",
  reddit: "Reddit",
  slack: "Slack",
  telegram: "Telegram",
  trello: "Trello",
  twitter: "Twitter",
  youtube: "YouTube",
};

function fallbackToolkitName(slug: string): string {
  return (
    FALLBACK_TOOLKIT_NAMES[slug] ??
    slug
      .replace(/^_/, "")
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ")
  );
}

export const FALLBACK_TOOLKITS: readonly ComposioToolkit[] = FALLBACK_TOOLKIT_SLUGS.map(
  (slug) => ({ slug, name: fallbackToolkitName(slug) }),
);

export function mergeComposioToolkitCatalogs(
  ...catalogs: readonly (readonly ComposioToolkit[])[]
): ComposioToolkit[] {
  const merged = new Map<string, ComposioToolkit>();
  for (const catalog of catalogs) {
    for (const toolkit of catalog) merged.set(toolkit.slug, toolkit);
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Reads Composio's structured catalog strictly. Rejecting a malformed entry or
 * duplicate prevents a localized upstream schema change from silently dropping
 * an app while allowing genuine additions, removals, and renames through.
 */
export function parseComposioToolkitCatalog(payload: unknown): ComposioToolkit[] {
  if (!Array.isArray(payload)) {
    throw new Error("Composio toolkit catalog was not an array");
  }

  const toolkits = new Map<string, ComposioToolkit>();
  for (const [index, entry] of payload.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Composio toolkit catalog entry ${index} was invalid`);
    }
    const { slug, name } = entry as { slug?: unknown; name?: unknown };
    if (
      typeof slug !== "string" ||
      !/^[a-z0-9_-]+$/.test(slug) ||
      typeof name !== "string" ||
      name.trim().length === 0
    ) {
      throw new Error(`Composio toolkit catalog entry ${index} was invalid`);
    }
    if (toolkits.has(slug)) {
      throw new Error(`Composio toolkit catalog contained duplicate slug ${slug}`);
    }
    toolkits.set(slug, { slug, name });
  }

  return [...toolkits.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function validateComposioToolkitCatalog(
  toolkits: readonly ComposioToolkit[],
): void {
  // A small count drift can be a legitimate rename or removal. Reject only a
  // substantial drop, which indicates that the page stopped exposing toolkit
  // links rather than a localized change to a row's presentation markup.
  const minimumExpected = Math.floor(FALLBACK_TOOLKITS.length * 0.9);
  if (toolkits.length < minimumExpected) {
    throw new Error(
      `Composio toolkit catalog was incomplete (${toolkits.length} found; expected at least ${minimumExpected})`,
    );
  }
}

async function fetchComposioToolkits(): Promise<ComposioToolkit[]> {
  const response = await fetch(TOOLKIT_CATALOG_URL, {
    cache: "no-store",
    headers: { accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(`Composio toolkit catalog failed (${response.status})`);
  }
  const toolkits = parseComposioToolkitCatalog(await response.json());
  validateComposioToolkitCatalog(toolkits);
  return toolkits;
}

// Cache the compact parsed catalog, not the multi-megabyte source payload (which
// exceeds Next's per-entry Data Cache limit).
const cachedComposioToolkits = unstable_cache(
  fetchComposioToolkits,
  ["composio-toolkit-catalog-v6"],
  { revalidate: 86_400 },
);

/** Load every current Composio toolkit, refreshed daily. */
export async function listComposioToolkits(): Promise<ComposioToolkit[]> {
  return cachedComposioToolkits();
}

interface McpToolResponse {
  result?: {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  error?: { message?: string };
}

function apiKey(): string {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error("COMPOSIO_API_KEY is not set");
  return key;
}

async function mcpFetch(body: object, sessionId?: string): Promise<Response> {
  return fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-consumer-api-key": apiKey(),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Parses a (possibly SSE-framed) MCP response body into its JSON message. */
async function parseMcpBody(response: Response): Promise<McpToolResponse> {
  const text = await response.text();
  if (text.startsWith("{")) return JSON.parse(text) as McpToolResponse;
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) return JSON.parse(line.slice(6)) as McpToolResponse;
  }
  throw new Error(`Unparseable MCP response (${response.status})`);
}

/** Calls COMPOSIO_MANAGE_CONNECTIONS and returns its parsed JSON payload. */
export async function manageConnections(
  toolkits: { name: string; action: "list" | "add" | "remove"; account_id?: string }[],
): Promise<Record<string, unknown>> {
  const init = await mcpFetch({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "eve-web", version: "1.0" },
    },
  });
  const sessionId = init.headers.get("mcp-session-id");
  if (!init.ok || sessionId === null) {
    throw new Error(`Composio Connect initialize failed (${init.status})`);
  }

  const call = await mcpFetch(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits } },
    },
    sessionId,
  );
  const message = await parseMcpBody(call);
  if (message.error) throw new Error(message.error.message ?? "MCP call failed");
  const text = message.result?.content?.find((entry) => entry.type === "text")?.text;
  if (text === undefined) throw new Error("Empty MCP tool response");
  const parsed = JSON.parse(text) as {
    data?: Record<string, unknown>;
    error?: string | null;
    successful?: boolean;
  };
  if (parsed.error) throw new Error(parsed.error);
  return parsed.data ?? {};
}
