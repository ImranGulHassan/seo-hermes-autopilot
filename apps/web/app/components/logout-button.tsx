export function LogoutButton() {
  return (
    <form action="/auth/logout" method="post">
      <button type="submit" className="logout-button">Sign out</button>
    </form>
  );
}
