// Website -> Synapse category. Matched by host suffix; anything else is "other".
// Users can override a site's category from the extension settings.
export const SITE_CATEGORIES = {
  social: ['instagram.com', 'facebook.com', 'x.com', 'twitter.com', 'reddit.com', 'tiktok.com', 'snapchat.com', 'linkedin.com', 'pinterest.com', 'threads.net', 'tumblr.com', 'quora.com', 'bsky.app', 'mastodon.social'],
  entertainment: ['youtube.com', 'netflix.com', 'primevideo.com', 'hotstar.com', 'jiocinema.com', 'twitch.tv', 'spotify.com', 'disneyplus.com', 'hulu.com', 'sonyliv.com', 'zee5.com', 'soundcloud.com', '9gag.com', 'crunchyroll.com'],
  communication: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'web.whatsapp.com', 'slack.com', 'teams.microsoft.com', 'discord.com', 'web.telegram.org', 'meet.google.com', 'zoom.us', 'messenger.com', 'proton.me', 'mail.yahoo.com'],
  work: ['github.com', 'gitlab.com', 'docs.google.com', 'sheets.google.com', 'drive.google.com', 'calendar.google.com', 'notion.so', 'figma.com', 'stackoverflow.com', 'atlassian.net', 'linear.app', 'chatgpt.com', 'claude.ai', 'vercel.com', 'canva.com', 'trello.com', 'asana.com', 'office.com', 'sharepoint.com', 'aws.amazon.com', 'console.cloud.google.com'],
  study: ['coursera.org', 'udemy.com', 'khanacademy.org', 'wikipedia.org', 'scholar.google.com', 'edx.org', 'leetcode.com', 'geeksforgeeks.org', 'w3schools.com', 'developer.mozilla.org', 'duolingo.com', 'arxiv.org', 'nptel.ac.in', 'kaggle.com'],
  news: ['news.google.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'theguardian.com', 'thehindu.com', 'indiatimes.com', 'ndtv.com', 'hindustantimes.com', 'reuters.com', 'bloomberg.com', 'indianexpress.com', 'news.ycombinator.com', 'moneycontrol.com'],
  games: ['chess.com', 'lichess.org', 'store.steampowered.com', 'poki.com', 'roblox.com', 'epicgames.com', 'miniclip.com', 'crazygames.com'],
};

const SUFFIXES = Object.entries(SITE_CATEGORIES)
  .flatMap(([cat, hosts]) => hosts.map((h) => [h, cat]))
  .sort((a, b) => b[0].length - a[0].length); // most specific first (mail.google.com before google.com)

export function categorize(host, overrides = {}) {
  if (overrides[host]) return overrides[host];
  for (const [suffix, cat] of SUFFIXES) if (host === suffix || host.endsWith('.' + suffix)) return cat;
  return 'other';
}

export const CATEGORY_LABELS = {
  work: 'Work', study: 'Study', communication: 'Messaging & email', social: 'Social media',
  entertainment: 'Video & streaming', games: 'Games', news: 'News', other: 'Other',
};
