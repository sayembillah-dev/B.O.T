import Room from '@/components/Room';

export default async function RoomPage({ params }) {
  const { id } = await params;
  return <Room roomId={String(id).toLowerCase()} />;
}
