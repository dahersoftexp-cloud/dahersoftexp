import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({
  scopes: [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/firebase.database",
  ],
});
let pending: Promise<string> | undefined;
export const getServerAccessToken = (): Promise<string> => {
  if (!pending)
    pending = Promise.resolve()
      .then(() => auth.getAccessToken())
      .then((token) => {
        if (!token) throw new Error("SERVER_CREDENTIALS_UNAVAILABLE");
        return token;
      })
      .catch(() => {
        throw new Error("SERVER_CREDENTIALS_UNAVAILABLE");
      })
      .finally(() => {
        pending = undefined;
      });
  return pending;
};
