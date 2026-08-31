const form = document.querySelector("#login-form");
const message = document.querySelector("#login-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.hidden = true;
  const password = new FormData(form).get("password");
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Sign-in failed.");
    window.location.href = "/admin";
  } catch (error) {
    message.textContent = error.message;
    message.hidden = false;
  }
});
