import './globals.css';

export const metadata = {
  title: 'my-game',
  description: 'Create a room, share the link, and friends join in real-time.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
