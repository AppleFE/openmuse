export default function BrowserConsole({ url }: { url: string }) {
  return (
    <iframe
      title="원격 브라우저 세션 콘솔"
      src={url}
      allow="fullscreen; clipboard-read; clipboard-write"
      allowFullScreen
      style={{ height: 540, width: "100%", border: 0, borderRadius: 12, background: "transparent" }}
    />
  );
}
