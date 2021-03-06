'use strict';

angular.module('bahmni.common.offline')
    .service('offlineSyncService', ['eventLogService', 'offlineDbService', '$q', 'offlineService', 'androidDbService', '$rootScope', 'loggingService', '$http', '$timeout', 'dbNameService',
        function (eventLogService, offlineDbService, $q, offlineService, androidDbService, $rootScope, loggingService, $http, $timeout, dbNameService) {
            var stages, categories;

            var createRejectedPromise = function () {
                var deferrable = $q.defer();
                deferrable.reject();
                return deferrable.promise;
            };

            var initializeInitSyncInfo = function initializeCounters (categories) {
                $rootScope.initSyncInfo = {};
                $rootScope.showSyncInfo = true;
                _.map(categories, function (category) {
                    $rootScope.initSyncInfo[category] = {};
                    $rootScope.initSyncInfo[category].pendingEventsCount = 0;
                    $rootScope.initSyncInfo[category].savedEventsCount = 0;
                });
                $rootScope.initSyncInfo.savedEvents = 0;
            };

            var savePatients = function (patients, count) {
                if (count != patients.length) {
                    return saveData({category: 'patient'}, {data: patients[count]}).then(function () {
                        updateSavedEventsCount('patient');
                        return (offlineService.isAndroidApp() && count % 10 == 0) ?
                            $timeout(savePatients, 100, true, patients, ++count) : savePatients(patients, ++count);
                    });
                }
                return $q.when();
            };

            var updateSyncedFileNames = function (fileName, dbName) {
                var syncedInfo = offlineService.getItem("synced") || {};
                syncedInfo[dbName] = syncedInfo[dbName] || [];
                syncedInfo[dbName].push(fileName);
                offlineService.setItem("synced", syncedInfo);
            };

            var getPatientDataForFiles = function (fileNames, count, eventLogUuid, dbName) {
                if (count != fileNames.length) {
                    return $http.get(Bahmni.Common.Constants.preprocessedPatientUrl + fileNames[count]).then(function (response) {
                        updatePendingEventsCount("patient", response.data.patients.length);
                        eventLogUuid = response.data.lastReadEventUuid;
                        return savePatients(response.data.patients, 0).then(function () {
                            updateSyncedFileNames(fileNames[count], dbName);
                            return getPatientDataForFiles(fileNames, ++count, eventLogUuid, dbName);
                        });
                    });
                }
                return $q.when(eventLogUuid);
            };

            var getDbName = function () {
                var loginInformation = offlineService.getItem('LoginInformation');
                var location = loginInformation ? loginInformation.currentLocation.display : null;
                var username = offlineService.getItem("userData").results[0].username;
                return dbNameService.getDbName(username, location);
            };

            var getRemainingFileNames = function (fileNames, synced) {
                var remaining = _.difference(fileNames, synced);
                return remaining.length ? remaining : [_.last(fileNames)];
            };

            var savePatientDataFromFile = function () {
                var eventLogUuid;
                var defer = $q.defer();
                offlineDbService.getMarker('patient').then(function (marker) {
                    if (marker.lastReadEventUuid) {
                        return defer.resolve();
                    }

                    return getDbName().then(function (dbName) {
                        var promises = marker.filters.map(function (filter) {
                            var syncedInfo = offlineService.getItem("synced") || {};
                            var synced = syncedInfo[dbName] || [];
                            return $http.get(Bahmni.Common.Constants.preprocessedPatientFilesUrl + filter).then(function (response) {
                                return getPatientDataForFiles(getRemainingFileNames(response.data, synced), 0, null, dbName).then(function (uuid) {
                                    eventLogUuid = uuid;
                                });
                            }).catch(function () {
                                endSync(-1);
                                return defer.reject();
                            });
                        });
                        return $q.all(promises).then(function () {
                            return defer.resolve(eventLogUuid);
                        });
                    });
                });
                return defer.promise;
            };

            var sync = function (isInitSync) {
                stages = 0;
                if (offlineService.isAndroidApp()) {
                    offlineDbService = androidDbService;
                }
                var promises = [];
                categories = offlineService.getItem("eventLogCategories");
                initializeInitSyncInfo(categories);
                _.forEach(categories, function (category) {
                    if (!isInitSync || category !== "patient") {
                        promises.push(syncForCategory(category, isInitSync));
                    }
                });
                if (isInitSync && _.indexOf(categories, 'patient') != -1) {
                    var patientPromise = savePatientDataFromFile().then(function (uuid) {
                        return updateMarker({uuid: uuid}, "patient");
                    });
                    promises.push(patientPromise);
                }
                return $q.all(promises);
            };

            var syncForCategory = function (category, isInitSync) {
                return offlineDbService.getMarker(category).then(function (marker) {
                    if (category == "encounter" && isInitSync) {
                        marker = angular.copy(marker);
                        marker.filters = offlineService.getItem("initSyncFilter");
                    }
                    return syncForMarker(category, marker, isInitSync);
                });
            };

            var updatePendingEventsCount = function updatePendingEventsCount (category, pendingEventsCount) {
                $rootScope.initSyncInfo[category].pendingEventsCount = pendingEventsCount;
                $rootScope.initSyncInfo.totalEvents = categories.reduce(function (count, category) {
                    return count + $rootScope.initSyncInfo[category].savedEventsCount + $rootScope.initSyncInfo[category].pendingEventsCount;
                }, 0);
            };

            var syncForMarker = function (category, marker, isInitSync) {
                return eventLogService.getEventsFor(category, marker).then(function (response) {
                    var events = response.data ? response.data["events"] : undefined;
                    updatePendingEventsCount(category, response.data.pendingEventsCount);
                    if (events == undefined || events.length == 0) {
                        endSync(stages++);
                        return;
                    }
                    return readEvent(events, 0, category, isInitSync);
                }, function () {
                    endSync(-1);
                    return createRejectedPromise();
                });
            };

            var readEvent = function (events, index, category, isInitSync) {
                if (events.length == index && events.length > 0) {
                    return syncForCategory(category, isInitSync);
                }
                if (events.length == index) {
                    return;
                }
                var event = events[index];
                if (event.category == "SHREncounter") {
                    var uuid = event.object.match(Bahmni.Common.Constants.uuidRegex)[0];
                    event.object = Bahmni.Common.Constants.offlineBahmniEncounterUrl + uuid + "?includeAll=true";
                }
                return eventLogService.getDataForUrl(Bahmni.Common.Constants.hostURL + event.object)
                    .then(function (response) {
                        return saveData(event, response)
                            .then(function () {
                                updateSavedEventsCount(category);
                                return updateMarker(event, category);
                            }, createRejectedPromise)
                            .then(
                                function (lastEvent) {
                                    offlineService.setItem("lastSyncTime", lastEvent.lastReadTime);
                                    return readEvent(events, ++index, category, isInitSync);
                                });
                    }).catch(function (response) {
                        logSyncError(response);
                        $rootScope.$broadcast("schedulerStage", null, true);
                        endSync(-1);
                        return createRejectedPromise();
                    });
            };

            var logSyncError = function (response) {
                if (response && (parseInt(response.status / 100) == 4 || parseInt(response.status / 100) == 5)) {
                    loggingService.logSyncError(response.config.url, response.status, response.data);
                }
            };

            var isPrimary = function (identifier, identifierTypes) {
                return identifier.identifierType.retired ? false : !!(_.find(identifierTypes, {'uuid': identifier.identifierType.uuid})).primary;
            };

            var mapIdentifiers = function (identifiers) {
                var deferred = $q.defer();
                return offlineDbService.getReferenceData("IdentifierTypes").then(function (identifierTypesData) {
                    var identifierTypes = identifierTypesData.data;
                    angular.forEach(identifiers, function (identifier) {
                        identifier.identifierType.primary = isPrimary(identifier, identifierTypes);
                    });
                    var extraIdentifiersForSearch = {};
                    var extraIdentifiers = _.filter(identifiers, {'identifierType': {'primary': false}});
                    var primaryIdentifier = _.filter(identifiers, {'identifierType': {'primary': true}})[0];
                    angular.forEach(extraIdentifiers, function (extraIdentifier) {
                        var name = extraIdentifier.identifierType.display || extraIdentifier.identifierType.name;
                        extraIdentifiersForSearch[name] = extraIdentifier.identifier;
                    });
                    angular.forEach(identifiers, function (identifier) {
                        identifier.primaryIdentifier = primaryIdentifier.identifier;
                        identifier.extraIdentifiers = !_.isEmpty(extraIdentifiersForSearch) ? extraIdentifiersForSearch : undefined;
                    });
                    deferred.resolve({data: identifiers});
                    return deferred.promise;
                });
            };

            var saveData = function (event, response) {
                var deferrable = $q.defer();
                switch (event.category) {
                case 'patient':
                    offlineDbService.getAttributeTypes().then(function (attributeTypes) {
                        mapAttributesToPostFormat(response.data.person.attributes, attributeTypes);
                        mapIdentifiers(response.data.identifiers).then(function () {
                            offlineDbService.createPatient({patient: response.data}).then(function () {
                                deferrable.resolve();
                            }, function (response) {
                                deferrable.reject(response);
                            });
                        });
                    });
                    break;
                case 'Encounter':
                case 'SHREncounter':
                    offlineDbService.createEncounter(response.data).then(function () {
                        deferrable.resolve();
                    });
                    break;
                case 'LabOrderResults':
                    var patientUuid = event.object.match(Bahmni.Common.Constants.uuidRegex)[0];
                    offlineDbService.insertLabOrderResults(patientUuid, response.data).then(function () {
                        deferrable.resolve();
                    });
                    break;

                case 'offline-concepts':
                    offlineDbService.insertConceptAndUpdateHierarchy({"results": [response.data]}).then(function () {
                        deferrable.resolve();
                    });
                    break;
                case 'addressHierarchy':
                case 'parentAddressHierarchy':
                    offlineDbService.insertAddressHierarchy(response.data).then(function () {
                        deferrable.resolve();
                    });
                    break;
                default:
                    deferrable.resolve();
                    break;
                }
                return deferrable.promise;
            };

            var mapAttributesToPostFormat = function (attributes, attributeTypes) {
                angular.forEach(attributes, function (attribute) {
                    if (!attribute.voided && !attribute.attributeType.retired) {
                        var foundAttribute = _.find(attributeTypes, function (attributeType) {
                            return attributeType.uuid === attribute.attributeType.uuid;
                        });
                        if (foundAttribute.format === "org.openmrs.Concept") {
                            var value = attribute.value;
                            attribute.value = value.display;
                            attribute.hydratedObject = value.uuid;
                        }
                    }
                });
            };

            var updateMarker = function (event, category) {
                return offlineDbService.getMarker(category).then(function (marker) {
                    return offlineDbService.insertMarker(marker.markerName, event.uuid, marker.filters);
                });
            };

            var updateSavedEventsCount = function (category) {
                $rootScope.initSyncInfo[category].savedEventsCount++;
                $rootScope.initSyncInfo[category].pendingEventsCount--;
                $rootScope.initSyncInfo.savedEvents++;
            };

            var endSync = function (status) {
                if (stages == categories.length || status == -1) {
                    $rootScope.$broadcast("schedulerStage", null);
                }
            };

            return {
                sync: sync
            };
        }
    ]);
