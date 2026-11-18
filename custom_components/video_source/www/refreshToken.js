export const getAccessToken = async () => {
    const hassConnection = window.hassConnection || window.parent?.hassConnection;
    if (!hassConnection) {
        return '';
    }
    try {
        const conn = await hassConnection;
        const auth = conn?.auth;
        if (!auth) {
            return '';
        }
        if (auth.expired) {
            if (!auth._refreshPromise) {
                auth._refreshPromise = Promise.resolve(auth.refreshAccessToken()).finally(() => {
                    auth._refreshPromise = null;
                });
            }
            await auth._refreshPromise;
        }
        return auth.accessToken || auth.data?.access_token || '';
    } catch (err) {
        console.warn(`Unable to get access token from Home Assistant: ${err}`);
        return '';
    }
};
