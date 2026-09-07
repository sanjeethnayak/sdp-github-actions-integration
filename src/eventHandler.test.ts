/*
 * Copyright 2022-2025 Open Text.
 *
 * The only warranties for products and services of Open Text and
 * its affiliates and licensors (“Open Text”) are as may be set forth
 * in the express warranty statements accompanying such products and services.
 * Nothing herein should be construed as constituting an additional warranty.
 * Open Text shall not be liable for technical or editorial errors or
 * omissions contained herein. The information contained herein is subject
 * to change without notice.
 *
 * Except as specifically indicated otherwise, this document contains
 * confidential information and a valid license is required for possession,
 * use or copying. If this work is provided to the U.S. Government,
 * consistent with FAR 12.211 and 12.212, Commercial Computer Software,
 * Computer Software Documentation, and Technical Data for Commercial Items are
 * licensed to the U.S. Government under vendor's standard commercial license.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *   http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

jest.mock('@actions/github', () => ({
  context: { workflow: 'test-workflow', runId: 1 },
  getOctokit: jest.fn().mockReturnValue({})
}));
jest.mock('./client/githubClient');
jest.mock('./client/octaneClient');
jest.mock('./config/config', () => ({
  getConfig: jest.fn().mockReturnValue({
    logLevel: 3,
    pipelineNamePattern: '${workflow_name}',
    serverBaseUrl: 'https://example.com',
    preservePipelineNames: false
  })
}));
jest.mock('./service/ciEventsService');
jest.mock('./service/pipelineDataService');
jest.mock('./service/scmDataService');
jest.mock('./service/testResultsService');
jest.mock('./service/migrationService');
jest.mock('./service/parametersService');
jest.mock('./service/experimentService');
jest.mock('./service/executorService');
jest.mock('./service/ciJobService');
jest.mock('./service/eventCauseBuilder');
jest.mock('./utils/genericPoller');
jest.mock('./utils/pathFormatter');

import { handleEvent } from './eventHandler';
import GitHubClient from './client/githubClient';
import OctaneClient from './client/octaneClient';
import { getConfig } from './config/config';
import ActionsEvent from './dto/github/ActionsEvent';
import ActionsEventType from './dto/github/ActionsEventType';
import { getEventType } from './service/ciEventsService';
import {
  buildPipelineName,
  getPipelineData,
  updatePipelineNameIfNeeded
} from './service/pipelineDataService';
import { performMigrations } from './service/migrationService';
import { getParametersFromConfig } from './service/parametersService';
import { Experiment, loadExperiments } from './service/experimentService';
import {
  appendBranchName,
  buildJobCiIdPrefix
} from './utils/pathFormatter';

const buildEvent = (): ActionsEvent =>
  ({
    repository: { owner: { login: 'owner' }, name: 'repo' },
    workflow: { path: '.github/workflows/build.yml', name: 'Build' },
    workflow_run: {
      id: 123,
      run_started_at: '2024-01-01T00:00:00Z',
      run_number: 1,
      head_branch: 'main',
      event: 'push',
      triggering_actor: { login: 'user' }
    }
  }) as unknown as ActionsEvent;

const mockPipelineData = {
  pipelineId: 'pipeline-id',
  instanceId: 'instance-id',
  buildCiId: '123',
  baseUrl: 'https://example.com',
  rootJobName: 'root-job',
  rootJobId: 'root-job-id'
};

describe('handleEvent - pipeline rename guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (getEventType as jest.Mock).mockReturnValue(
      ActionsEventType.WORKFLOW_QUEUED
    );
    (GitHubClient.getWorkflowRun as jest.Mock).mockResolvedValue({});
    (GitHubClient.getWorkflowRunJobs as jest.Mock).mockResolvedValue([]);
    (OctaneClient.getCiServerOrCreate as jest.Mock).mockResolvedValue({
      instance_id: 'instance-id'
    });
    (OctaneClient.updatePluginVersionIfNeeded as jest.Mock).mockResolvedValue(
      undefined
    );
    (OctaneClient.getOctaneVersion as jest.Mock).mockResolvedValue('25.1.4');
    (buildJobCiIdPrefix as jest.Mock).mockResolvedValue('job-ci-id-prefix');
    (appendBranchName as jest.Mock).mockResolvedValue(
      'job-ci-id-prefix/main'
    );
    (getParametersFromConfig as jest.Mock).mockResolvedValue(undefined);
    (loadExperiments as jest.Mock).mockResolvedValue(undefined);
    (
      Experiment.CUSTOM_BUILD_URL_FOR_GITHUB_ACTIONS.isOn as jest.Mock
    ).mockReturnValue(false);
    (performMigrations as jest.Mock).mockResolvedValue(undefined);
    (buildPipelineName as jest.Mock).mockReturnValue('MyPipeline');
    (getPipelineData as jest.Mock).mockResolvedValue(mockPipelineData);
    (updatePipelineNameIfNeeded as jest.Mock).mockResolvedValue(undefined);
  });

  it('calls updatePipelineNameIfNeeded by default (preservePipelineNames not set)', async () => {
    (getConfig as jest.Mock).mockReturnValue({
      pipelineNamePattern: '${workflow_name}',
      serverBaseUrl: 'https://example.com',
      preservePipelineNames: false
    });

    await handleEvent(buildEvent());

    expect(updatePipelineNameIfNeeded).toHaveBeenCalledWith(
      'job-ci-id-prefix*',
      expect.objectContaining({ instance_id: 'instance-id' }),
      'MyPipeline'
    );
    expect(getPipelineData).toHaveBeenCalledWith(
      'MyPipeline',
      expect.anything(),
      expect.anything(),
      true,
      'job-ci-id-prefix',
      [],
      undefined
    );
  });

  it('skips updatePipelineNameIfNeeded when preservePipelineNames is true', async () => {
    (getConfig as jest.Mock).mockReturnValue({
      pipelineNamePattern: '${workflow_name}',
      serverBaseUrl: 'https://example.com',
      preservePipelineNames: true
    });

    await handleEvent(buildEvent());

    expect(updatePipelineNameIfNeeded).not.toHaveBeenCalled();
    expect(getPipelineData).toHaveBeenCalledWith(
      'MyPipeline',
      expect.anything(),
      expect.anything(),
      true,
      'job-ci-id-prefix',
      [],
      undefined
    );
  });

  it('regression: does not rename an existing pipeline when a second pipelineName shares the same root job CI ID', async () => {
    (getConfig as jest.Mock).mockReturnValue({
      pipelineNamePattern: '${workflow_name}',
      serverBaseUrl: 'https://example.com',
      preservePipelineNames: true
    });

    (buildPipelineName as jest.Mock).mockReturnValueOnce('FirstPipeline');
    await handleEvent(buildEvent());

    (buildPipelineName as jest.Mock).mockReturnValueOnce('SecondPipeline');
    await handleEvent(buildEvent());

    expect(updatePipelineNameIfNeeded).not.toHaveBeenCalled();
    expect(getPipelineData).toHaveBeenNthCalledWith(
      1,
      'FirstPipeline',
      expect.anything(),
      expect.anything(),
      true,
      'job-ci-id-prefix',
      [],
      undefined
    );
    expect(getPipelineData).toHaveBeenNthCalledWith(
      2,
      'SecondPipeline',
      expect.anything(),
      expect.anything(),
      true,
      'job-ci-id-prefix',
      [],
      undefined
    );
  });
});
