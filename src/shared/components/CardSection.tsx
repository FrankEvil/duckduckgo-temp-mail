import { PropsWithChildren } from "react";

type CardSectionProps = PropsWithChildren<{
  title: string;
  description: string;
}>;

export function CardSection({
  title,
  description,
  children
}: CardSectionProps) {
  return (
    <section className="card-section">
      <div className="card-header">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}
