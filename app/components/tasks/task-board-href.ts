/** The link to one repository's task board. */
export const taskBoardHref = (repositoryId: string) => `/tasks?${new URLSearchParams({ repository: repositoryId })}`;
