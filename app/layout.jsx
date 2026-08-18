import './globals.css';

export const metadata = {
  title: 'B.O.T - battle of tanks',
  description: 'B.O.T - battle of tanks: Worms-style artillery on destructible terrain. Create a room, share the link, and friends join in real-time.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
