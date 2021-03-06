'use strict';

import _ from 'lodash';

const angular = require('angular');

import {ExecutionBarLabel} from 'core/pipeline/config/stages/core/ExecutionBarLabel';
import {ExecutionMarkerIcon} from 'core/pipeline/config/stages/core/ExecutionMarkerIcon';
import {ORCHESTRATED_ITEM_TRANSFORMER} from 'core/orchestratedItem/orchestratedItem.transformer';
import {PIPELINE_CONFIG_PROVIDER} from 'core/pipeline/config/pipelineConfigProvider';

module.exports = angular.module('spinnaker.core.delivery.executionTransformer.service', [
  ORCHESTRATED_ITEM_TRANSFORMER,
  PIPELINE_CONFIG_PROVIDER,
])
  .factory('executionsTransformer', function(orchestratedItemTransformer, pipelineConfig) {

    var hiddenStageTypes = ['initialization', 'pipelineInitialization', 'waitForRequisiteCompletion', 'determineTargetServerGroup'];

    function transformExecution(application, execution) {

      if (execution.trigger) {
        execution.isStrategy = execution.trigger.isPipeline === false && execution.trigger.type === 'pipeline';
      }
      applyPhasesAndLink(execution);
      pipelineConfig.getExecutionTransformers().forEach(function(transformer) {
        transformer.transform(application, execution);
      });
      var stageSummaries = [];

      execution.context = execution.context || {};
      execution.stages.forEach(function(stage, index) {
        stage.before = stage.before || [];
        stage.after = stage.after || [];
        stage.index = index;
        orchestratedItemTransformer.defineProperties(stage);
        if (stage.tasks && stage.tasks.length) {
          stage.tasks.forEach(t => orchestratedItemTransformer.addRunningTime(t));
        }
      });

      execution.stages.forEach(function(stage) {
        let context = stage.context || {};
        var owner = stage.syntheticStageOwner;
        var parent = _.find(execution.stages, { id: stage.parentStageId });
        if (parent) {
          if (owner === 'STAGE_BEFORE') {
            parent.before.push(stage);
          }
          if (owner === 'STAGE_AFTER') {
            parent.after.push(stage);
          }
        }
        stage.cloudProvider = context.cloudProvider || context.cloudProviderType;
      });

      execution.stages.forEach(function(stage) {
        if (!stage.syntheticStageOwner && !hiddenStageTypes.includes(stage.type)) {
          // HACK: Orca sometimes (always?) incorrectly reports a parent stage as running when a child stage has stopped
          if (stage.status === 'RUNNING' && stage.after.some(s => s.status === 'STOPPED')) {
            stage.status = 'STOPPED';
          }
          let context = stage.context || {};
          stageSummaries.push({
            name: stage.name,
            id: stage.id,
            startTime: stage.startTime,
            endTime: stage.endTime,
            masterStage: stage,
            type: stage.type,
            before: stage.before,
            after: stage.after,
            status: stage.status,
            comments: context.comments || null,
            cloudProvider: stage.cloudProvider,
            refId: stage.refId,
            requisiteStageRefIds: stage.requisiteStageRefIds && stage.requisiteStageRefIds[0] === '*' ? [] : stage.requisiteStageRefIds || [],
          });
        }
      });

      orchestratedItemTransformer.defineProperties(execution);

      stageSummaries.forEach(transformStageSummary);
      execution.stageSummaries = stageSummaries;
      execution.currentStages = getCurrentStages(execution);
      addStageWidths(execution);
      addBuildInfo(execution);
      addDeploymentTargets(execution);
      //let end = window.performance.now();
      //totalTime += (end-start);
      //console.warn('tt:', totalTime, '(this)', (end-start));
    }

    function addDeploymentTargets(execution) {
      const targets = [];
      execution.stages.map(stage => {
        const stageConfig = pipelineConfig.getStageConfig(stage);
        if (stageConfig && stageConfig.accountExtractor) {
          targets.push(stageConfig.accountExtractor(stage));
        }
      });
      execution.deploymentTargets = _.uniq(_.flattenDeep(targets)).sort();
    }

    function siblingStageSorter(a, b) {
      if (!a.startTime && !b.startTime) {
        return 0;
      }
      if (!a.startTime) {
        return 1;
      }
      if (!b.startTime) {
        return -1;
      }
      return a.startTime - b.startTime;
    }

    function flattenStages(stages, stage) {
      if (stage.before && stage.before.length) {
        stage.before.sort(siblingStageSorter);
        stage.before.forEach(function(beforeStage) {
          flattenStages(stages, beforeStage);
        });
      }
      if (stage.masterStage) {
        stages.push(stage.masterStage);
      } else {
        stages.push(stage);
      }
      if (stage.after && stage.after.length) {
        stage.after.sort(siblingStageSorter);
        stage.after.forEach(function(afterStage) {
          flattenStages(stages, afterStage);
        });
      }
      return stages;
    }

    function flattenAndFilter(stage) {
      return flattenStages([], stage)
        .filter(stage => stage.isFailed ||
          (!hiddenStageTypes.includes(stage.type) && stage.initializationStage !== true));
    }

    function getCurrentStages(execution) {
      var currentStages = execution.stageSummaries.filter(function(stage) {
        return stage.isRunning;
      });
      // if there are no running stages, find the first enqueued stage
      if (!currentStages.length) {
        var enqueued = execution.stageSummaries.filter(function(stage) {
          return stage.hasNotStarted;
        });
        if (enqueued && enqueued.length) {
          currentStages = [enqueued[0]];
        }
      }
      return currentStages;
    }

    // TODO: remove if we ever figure out why quickPatchAsgStage never has a startTime
    function setMasterStageStartTime(stages, stage) {
      let allStartTimes = stages
        .filter((child) => child.startTime)
        .map((child) => child.startTime);
      if (allStartTimes.length) {
        stage.startTime = Math.min(...allStartTimes);
      }
    }

    function transformStage(stage) {
      var stages = flattenAndFilter(stage);

      if (!stages.length) {
        return;
      }

      if (stage.masterStage) {
        var lastStage = stages[stages.length - 1];
        setMasterStageStartTime(stages, stage);
        var lastNotStartedStage = _.findLast(stages,
          function (childStage) {
            return childStage.hasNotStarted;
          }
        );

        var lastFailedStage = _.findLast(stages,
          function (childStage) {
            return childStage.isFailed;
          }
        );

        var lastRunningStage = _.findLast(stages,
          function (childStage) {
            return childStage.isRunning;
          }
        );

        var lastCanceledStage = _.findLast(stages,
          function (childStage) {
            return childStage.isCanceled;
          }
        );

        var lastStoppedStage = _.findLast(stages,
          function (childStage) {
            return childStage.isStopped;
          }
        );

        var currentStage = lastRunningStage || lastFailedStage || lastStoppedStage || lastCanceledStage || lastNotStartedStage || lastStage;
        stage.status = currentStage.status;
        // if a stage is running, ignore the endTime of the parent stage
        if (!currentStage.endTime) {
          delete stage.endTime;
        }
        let lastEndingStage = _.maxBy(stages, 'endTime');
        // if the current stage has an end time (i.e. it failed or completed), use the maximum end time
        // of all the child stages as the end time for the parent - we do this because the parent might
        // have been an initialization stage, which ends within a few milliseconds
        if (currentStage.endTime && lastEndingStage.endTime) {
          stage.endTime = Math.max(currentStage.endTime, lastEndingStage.endTime, stage.endTime);
        }
      }
      stage.stages = stages;

    }

    function applyPhasesAndLink(execution) {
      if (!execution.parallel) {
        return;
      }
      var stages = execution.stages;
      var allPhasesResolved = true;
      // remove any invalid requisiteStageRefIds, set requisiteStageRefIds to empty for synthetic stages
      stages.forEach(function (stage) {
        if (_.has(stage, 'context.requisiteIds')) {
          stage.context.requisiteIds = _.uniq(stage.context.requisiteIds);
        }
        stage.requisiteStageRefIds = _.uniq(stage.requisiteStageRefIds || []);
        stage.requisiteStageRefIds = stage.requisiteStageRefIds.filter(function(parentId) {
          return _.find(stages, { refId: parentId });
        });
      });
      stages.forEach(function (stage) {
        var phaseResolvable = true,
          phase = 0;
        // if there are no dependencies or it's a synthetic stage, set it to 0
        if (stage.phase === undefined && !stage.requisiteStageRefIds.length) {
          stage.phase = phase;
        } else {
          stage.requisiteStageRefIds.forEach(function (parentId) {
            var parent = _.find(stages, { refId: parentId });
            if (!parent || parent.phase === undefined) {
              phaseResolvable = false;
            } else {
              phase = Math.max(phase, parent.phase);
            }
          });
          if (phaseResolvable) {
            stage.phase = phase + 1;
          } else {
            allPhasesResolved = false;
          }
        }
      });
      execution.stages = _.sortBy(stages, 'phase', 'refId');
      if (!allPhasesResolved) {
        applyPhasesAndLink(execution);
      }
    }

    function addStageWidths(execution) {
      execution.stageWidth = 100 / execution.stageSummaries.length + '%';
    }

    function styleStage(stage) {
      var stageConfig = pipelineConfig.getStageConfig(stage);
      if (stageConfig) {
        stage.labelComponent = stageConfig.executionLabelComponent || ExecutionBarLabel;
        stage.markerIcon = stageConfig.markerIcon || ExecutionMarkerIcon;
        stage.useCustomTooltip = !!stageConfig.useCustomTooltip;
        stage.extraLabelLines = stageConfig.extraLabelLines;
      }
    }

    function findNearestBuildInfo(execution) {
      if (_.get(execution, 'trigger.buildInfo.number')) {
        return execution.trigger.buildInfo;
      }
      if (_.get(execution, 'trigger.parentExecution')) {
        return findNearestBuildInfo(execution.trigger.parentExecution);
      }
      return null;
    }

    function addBuildInfo(execution) {
      execution.buildInfo = findNearestBuildInfo(execution);

      if (_.get(execution, 'trigger.buildInfo.lastBuild.number')) {
        execution.buildInfo = execution.trigger.buildInfo.lastBuild;
      }
      var deploymentDetails = _.chain(execution.stages)
        .find(function(stage) {
          return stage.type === 'deploy';
        })
        .get('context')
        .get('deploymentDetails')
        .value();

      // TODO - remove 'deploymentDetails || ...' once we've finalized the migration away from per-stage deploymentDetails
      // var deploymentDetails = execution.context.deploymentDetails;
      deploymentDetails = deploymentDetails || execution.context.deploymentDetails;

      if (deploymentDetails && deploymentDetails.length && deploymentDetails[0].jenkins) {
        let jenkins = deploymentDetails[0].jenkins;
        execution.buildInfo = {
          number: jenkins.number,
          url: deploymentDetails[0].buildInfoUrl || `${jenkins.host}job/${jenkins.name}/${jenkins.number}`
        };
      }
    }

    function transformStageSummary(summary, index) {
      summary.index = index;
      summary.stages = flattenAndFilter(summary);
      summary.stages.forEach(transformStage);
      summary.stages.forEach((stage) => delete stage.stages);
      summary.masterStageIndex = summary.stages.includes(summary.masterStage) ? summary.stages.indexOf(summary.masterStage) : 0;
      filterStages(summary);
      setFirstActiveStage(summary);
      setExecutionWindow(summary);
      transformStage(summary);
      styleStage(summary);
      orchestratedItemTransformer.defineProperties(summary);
    }

    function filterStages(summary) {
      const stageConfig = pipelineConfig.getStageConfig(summary.masterStage);
      if (stageConfig && stageConfig.stageFilter) {
        summary.stages = summary.stages.filter(stageConfig.stageFilter);
      }
    }

    function setExecutionWindow(summary) {
      if (summary.stages.some(s => s.type === 'restrictExecutionDuringTimeWindow' && s.isSuspended)) {
        summary.inSuspendedExecutionWindow = true;
      }
    }

    function setFirstActiveStage(summary) {
      summary.firstActiveStage = 0;
      let steps = summary.stages || [];
      if (steps.find(s => s.isRunning)) {
        summary.firstActiveStage = steps.findIndex(s => s.isRunning);
      }
      if (steps.find(s => s.isFailed)) {
        summary.firstActiveStage = steps.findIndex(s => s.isFailed);
      }
    }

    return {
      transformExecution: transformExecution
    };
  });
