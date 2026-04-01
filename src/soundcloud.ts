type OEmbedResponse = {
  title: string;
  thumbnail_url: string | null;
  author_name: string;
  html: string;
};

export async function fetchTrackMeta(url: string): Promise<{ title: string; artwork: string | null }> {
  const endpoint = `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetch(endpoint);
  if (!res.ok) {
    throw new Error(`SoundCloud oEmbed failed: ${res.status}`);
  }
  const data = (await res.json()) as OEmbedResponse;
  return {
    title: data.title,
    artwork: data.thumbnail_url ?? null,
  };
}
