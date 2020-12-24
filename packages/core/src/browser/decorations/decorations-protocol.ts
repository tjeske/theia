/********************************************************************************
 * Copyright (C) 2019 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { CancellationToken, Event, Disposable } from '../../common';
import { URI } from 'vscode-uri';

export interface IDecorationsProvider {
    readonly label: string;
    readonly onDidChange: Event<URI[]>;
    provideDecorations(uri: URI, token: CancellationToken): IDecorationData | Promise<IDecorationData | undefined> | undefined;
}

export interface IDecorationData {
    readonly weight?: number;
    readonly color?: string;
    readonly letter?: string;
    readonly tooltip?: string;
    readonly bubble?: boolean;
}

export interface IResourceDecorationChangeEvent {
    affectsResource(uri: URI): boolean;
}
export const DecorationsService = Symbol('DecorationsService');
export interface DecorationsService {

    readonly _serviceBrand: undefined;

    readonly onDidChangeDecorations: Event<IResourceDecorationChangeEvent>;

    registerDecorationsProvider(provider: IDecorationsProvider): Disposable;

    getDecoration(uri: URI, includeChildren: boolean): IDecorationData [];
}
