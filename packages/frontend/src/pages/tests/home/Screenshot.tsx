// A product screenshot shown as-is: the page's textures never touch the
// captures, so the real UI always reads exactly as it ships.

type Props = { src: string; alt: string; eager?: boolean };

export function Screenshot({ src, alt, eager }: Props) {
  return (
    <figure className="th-shot">
      <img
        src={src}
        alt={alt}
        width={1920}
        height={1200}
        decoding="async"
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : undefined}
      />
    </figure>
  );
}
