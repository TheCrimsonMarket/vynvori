import { LinkButton } from "./link-button";
export function Unavailable({ title, description }: { title: string; description: string }) {
  return <section className="atelier unavailable"><p className="eyebrow">VYNVORI / PREVIEW</p><h1>{title}</h1><p className="lede">{description}</p><LinkButton href="/" outline>Return to the atelier</LinkButton></section>;
}
