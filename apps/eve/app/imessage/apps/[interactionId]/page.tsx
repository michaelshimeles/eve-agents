import { InteractionCard } from "./interaction-card";

export default async function IMessageInteractionPage(props: {
  readonly params: Promise<{ interactionId: string }>;
  readonly searchParams: Promise<{ token?: string }>;
}): Promise<React.ReactNode> {
  const [{ interactionId }, search] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  return (
    <InteractionCard
      interactionId={interactionId}
      token={search.token ?? ""}
    />
  );
}
