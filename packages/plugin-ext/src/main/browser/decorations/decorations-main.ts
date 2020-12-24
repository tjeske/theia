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
import {
    DecorationData,
    DecorationRequest,
    DecorationsExt,
    DecorationsMain,
    MAIN_RPC_CONTEXT
} from '../../../common/plugin-api-rpc';

import { interfaces } from 'inversify';
import { Emitter } from '@theia/core/lib/common/event';
import { Disposable } from '@theia/core/lib/common/disposable';
import { RPCProtocol } from '../../../common/rpc-protocol';
import { DecorationsService, IDecorationData } from '@theia/core/lib/browser/decorations/decorations-protocol';
import { UriComponents } from '../../../common/uri-components';
import { URI } from 'vscode-uri';
import { CancellationToken } from '@theia/core/lib/common/cancellation';

class DecorationRequestsQueue {

    private _idPool = 0;
    private _requests = new Map<number, DecorationRequest>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _resolver = new Map<number, (data: DecorationData) => any>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _timer: any;

    constructor(
        private readonly _proxy: DecorationsExt,
        private readonly _handle: number
    ) {
        //
    }

    enqueue(uri: URI, token: CancellationToken): Promise<DecorationData> {
        const id = ++this._idPool;
        const result = new Promise<DecorationData>(resolve => {
            this._requests.set(id, { id, uri });
            this._resolver.set(id, resolve);
            this._processQueue();
        });
        token.onCancellationRequested(() => {
            this._requests.delete(id);
            this._resolver.delete(id);
        });
        return result;
    }

    private _processQueue(): void {
        if (typeof this._timer === 'number') {
            // already queued
            return;
        }
        this._timer = setTimeout(() => {
            // make request
            const requests = this._requests;
            const resolver = this._resolver;
            this._proxy.$provideDecorations(this._handle, [...requests.values()], CancellationToken.None).then(data => {
                for (const [id, resolve] of resolver) {
                    resolve(data[id]);
                }
            });

            // reset
            this._requests = new Map();
            this._resolver = new Map();
            this._timer = undefined;
        }, 0);
    }
}

export class DecorationsMainImpl implements DecorationsMain, Disposable {

    private readonly proxy: DecorationsExt;
    private readonly providers = new Map<number, [Emitter<URI[]>, Disposable]>();
    private readonly decorationsService: DecorationsService;

    constructor(rpc: RPCProtocol, container: interfaces.Container) {
        this.proxy = rpc.getProxy(MAIN_RPC_CONTEXT.DECORATIONS_EXT);
        this.decorationsService = container.get(DecorationsService);
    }

    dispose(): void {
        this.providers.forEach(value => value.forEach(v => v.dispose()));
        this.providers.clear();
    }

    async $registerDecorationProvider(handle: number, label: string): Promise<void> {
        const emitter = new Emitter<URI[]>();
        const queue = new DecorationRequestsQueue(this.proxy, handle);
        const registration = this.decorationsService.registerDecorationsProvider({
            label,
            onDidChange: emitter.event,
            provideDecorations: async (uri, token) => {
                const data = await queue.enqueue(uri, token);
                if (!data) {
                    return undefined;
                }
                const [bubble, tooltip, letter, themeColor] = data;
                return <IDecorationData>{
                    weight: 10,
                    bubble: bubble ?? false,
                    color: themeColor?.id,
                    tooltip,
                    letter
                };
            }
        });
        this.providers.set(handle, [emitter, registration]);
    }

    $onDidChange(handle: number, resources: UriComponents[]): void {
        const provider = this.providers.get(handle);
        if (provider) {
            const [emitter] = provider;
            emitter.fire(resources && resources.map(r => URI.revive(r)));
        }
    }

    $unregisterDecorationProvider(handle: number): void {
        const provider = this.providers.get(handle);
        if (provider) {
            provider.forEach(p => p.dispose());
            this.providers.delete(handle);
        }
    }
}
