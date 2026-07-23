export interface RepositoryActivationTarget {
  currentRepositoryId: string | null;
  storeMasterKey(repositoryId: string, encodedMasterKey: string): Promise<void>;
  clearWorkspaceMappings(): Promise<void>;
  setRepositoryPath(repositoryPath: string): Promise<void>;
  setRepositoryId(repositoryId: string): Promise<void>;
  deleteMasterKey(repositoryId: string): Promise<void>;
}

export async function activateRepository(
  target: RepositoryActivationTarget,
  repositoryPath: string,
  repositoryId: string,
  encodedMasterKey: string,
): Promise<void> {
  const previousRepositoryId = target.currentRepositoryId;
  await target.storeMasterKey(repositoryId, encodedMasterKey);
  if (previousRepositoryId !== repositoryId) {
    await target.clearWorkspaceMappings();
  }
  await target.setRepositoryPath(repositoryPath);
  await target.setRepositoryId(repositoryId);
  if (
    previousRepositoryId !== null &&
    previousRepositoryId !== repositoryId
  ) {
    await target.deleteMasterKey(previousRepositoryId);
  }
}
