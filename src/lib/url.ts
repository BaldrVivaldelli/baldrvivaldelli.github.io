// Internal links go through here so the site works under any base path.
export const url = (path = '') => import.meta.env.BASE_URL.replace(/\/?$/, '/') + path.replace(/^\//, '');
